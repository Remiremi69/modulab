// Analyse déterministe d'un site de traiteur : aucune IA ici.
// Toutes les preuves sont des extraits copiés tels quels du texte de la page (ou des données
// INSEE pour la taille et la date de création), donc vérifiables par construction.

export type Page = { url: string; html: string; texte: string; liens: Lien[] };
export type Lien = { href: string; texte: string };
export type Critere = { critere: string; points: number; preuve: string; url_preuve: string };

export type Entreprise = {
  siren: string;
  nom: string;
  noms: string[]; // nom complet, nom commercial, enseignes
  commune: string;
  dateCreation: string | null;
  tranche: string | null;
  nbEtablissementsOuverts: number;
  departement: string;
};

export type Analyse = {
  criteres: Critere[];
  exclusion: string | null;
  a_verifier: string[];
};

// --- Récupération et nettoyage des pages ------------------------------------------------

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) prospection-limen";

export async function telecharger(url: string, timeoutMs = 12_000): Promise<Page | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" },
      redirect: "follow",
    });
    const type = resp.headers.get("content-type") ?? "";
    if (!resp.ok || !type.includes("html")) return null;
    const octets = new Uint8Array(await resp.arrayBuffer());
    const html = decoder(octets, type);
    return construirePage(resp.url || url, html);
  } catch {
    return null;
  }
}

function decoder(octets: Uint8Array, contentType: string): string {
  const tete = new TextDecoder("latin1").decode(octets.slice(0, 2048));
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(tete)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(octets);
  } catch {
    return new TextDecoder("utf-8").decode(octets);
  }
}

export function construirePage(url: string, html: string): Page {
  const liens: Lien[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      liens.push({ href: new URL(decoderEntites(m[1]), url).href, texte: nettoyer(texteBrut(m[2])) });
    } catch {
      // lien invalide : ignoré
    }
  }
  return { url, html, texte: texteBrut(html), liens };
}

function texteBrut(html: string): string {
  return decoderEntites(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/button|\/a)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map(nettoyer)
    .filter(Boolean)
    .join("\n");
}

const ENTITES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”",
  ldquo: "“", laquo: "«", raquo: "»", hellip: "…", euro: "€", ndash: "–", mdash: "—", deg: "°",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", ccedil: "ç", icirc: "î",
  iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù", ucirc: "û", uuml: "ü", oelig: "œ", Eacute: "É",
  Egrave: "È", Agrave: "À", Ccedil: "Ç", Ecirc: "Ê", Ocirc: "Ô",
};

function decoderEntites(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tout, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : tout;
    }
    return ENTITES[e] ?? tout;
  });
}

function nettoyer(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Minuscules sans accents, pour comparer. */
export function normaliser(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Premier extrait (≤ 220 caractères) du texte qui contient le motif, copié tel quel.
 * Un extrait trop long est coupé autour du motif, sans rien réécrire.
 */
export function extrait(texte: string, motif: RegExp): string | null {
  const phrases = texte.split("\n").flatMap((ligne) => ligne.split(/(?<=[.!?])\s+/));
  // Une vraie phrase (≥ 5 mots) est une meilleure preuve qu'un intitulé de menu ; à défaut, l'intitulé.
  for (const minMots of [5, 1]) {
    for (const phrase of phrases) {
      const m = motif.exec(phrase);
      if (!m || phrase.split(" ").length < minMots) continue;
      if (phrase.length <= 220) return phrase;
      const debut = Math.max(0, phrase.lastIndexOf(" ", Math.max(0, m.index - 90)) + 1);
      const fin = phrase.indexOf(" ", Math.min(phrase.length, m.index + m[0].length + 90));
      return phrase.slice(debut, fin === -1 ? undefined : fin);
    }
  }
  return null;
}

// --- Identification du site ------------------------------------------------------------

const MOTS_VIDES = new Set([
  "traiteur", "traiteurs", "maison", "les", "des", "aux", "sas", "sarl", "eurl", "sasu", "snc",
  "gastronomie", "cuisine", "reception", "receptions", "evenement", "evenements", "lyon", "chez",
  "societe", "entreprise", "groupe", "france", "service", "services", "restauration",
]);

/** Mots distinctifs du nom (ex. « MAMIE KOCOTTE » → ["mamie", "kocotte"]). */
export function motsDistinctifs(nom: string): string[] {
  return normaliser(nom.replace(/\(.*?\)/g, " "))
    .split(" ")
    .filter((m) => m.length >= 4 && !MOTS_VIDES.has(m));
}

/** URLs plausibles à tester pour le site d'une entreprise (sans recherche web). */
export function urlsCandidates(e: Entreprise): string[] {
  const slugs = new Set<string>();
  for (const nom of e.noms) {
    const mots = normaliser(nom.replace(/\(.*?\)/g, " "))
      .split(" ")
      .filter((m) => m && !["sas", "sarl", "eurl", "sasu", "snc", "sa"].includes(m));
    if (mots.length === 0 || mots.join("").length < 4) continue;
    slugs.add(mots.join("-"));
    slugs.add(mots.join(""));
    const sansTraiteur = mots.filter((m) => m !== "traiteur" && m !== "traiteurs");
    if (sansTraiteur.length > 0 && sansTraiteur.length < mots.length) {
      slugs.add(`${sansTraiteur.join("-")}-traiteur`);
      slugs.add(`traiteur-${sansTraiteur.join("-")}`);
    } else if (sansTraiteur.length === mots.length) {
      slugs.add(`${mots.join("-")}-traiteur`);
    }
  }
  const urls: string[] = [];
  for (const slug of slugs) for (const tld of ["fr", "com"]) urls.push(`https://www.${slug}.${tld}/`);
  return urls.slice(0, 12);
}

/** La page parle-t-elle bien de cette entreprise ? */
export function siteCorrespond(page: Page, e: Entreprise): boolean {
  const t = normaliser(page.texte + " " + (/<title>([\s\S]*?)<\/title>/i.exec(page.html)?.[1] ?? ""));
  const mots = [...new Set(e.noms.flatMap(motsDistinctifs))];
  const nomPresent = mots.length > 0 ? mots.some((m) => t.includes(m)) : false;
  const metier = /\b(traiteur|traiteurs|reception|receptions|mariage|buffet|cocktail)\b/.test(t);
  // Bonne zone : la commune du siège, un code postal du département, Lyon ou le Rhône.
  // Évite les homonymes (ex. un restaurant du même nom à Aix-en-Provence).
  const commune = normaliser(e.commune.replace(/\b\d+E? ARRONDISSEMENT\b/i, ""));
  const dep = e.departement;
  const zone =
    (commune.length > 2 && t.includes(commune)) ||
    new RegExp(`\\b${dep}\\d{3}\\b`).test(page.texte) ||
    (dep === "69" && /\b(lyon|lyonnais|rhone|beaujolais|villeurbanne)\b/.test(t));
  return nomPresent && metier && zone;
}

// --- Choix des pages à lire ------------------------------------------------------------

const PAGES_UTILES: [string, RegExp][] = [
  ["contact", /contact|devis|nous-ecrire|demande/i],
  ["menus", /menu|carte|tarif|formule|prix|brochure/i],
  ["mariage", /mariage|evenement|événement|prestation|reception|réception|particulier/i],
];

export function pagesACharger(accueil: Page): string[] {
  const hote = new URL(accueil.url).host;
  const choisies: string[] = [];
  for (const [, motif] of PAGES_UTILES) {
    const lien = accueil.liens.find(
      (l) =>
        new URL(l.href).host === hote &&
        !/\.(pdf|jpe?g|png|webp)(\?|$)/i.test(l.href) &&
        l.href !== accueil.url &&
        !choisies.includes(l.href) &&
        (motif.test(l.texte) || motif.test(decodeURIComponentSur(new URL(l.href).pathname))),
    );
    if (lien) choisies.push(lien.href);
  }
  return choisies;
}

function decodeURIComponentSur(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// --- Grille de notation ----------------------------------------------------------------

const OUTIL_DEVIS = /configurateur|simulateur|calculez votre (devis|budget|prix)|composez votre menu|devis instantan|estimation en ligne|obtenez votre prix/i;
const SUR_DEVIS = /sur devis|sur demande|devis gratuit|nous consulter|tarifs? personnalis/i;
const FICHIER_MENU = /menu|carte|tarif|formule|mariage|buffet|cocktail|brochure|plaquette/i;
const APPEL_CONTACT = /devis|contactez|nous contacter|contact|écrivez-nous|ecrivez-nous/i;
const MARIAGE = /mariage|anniversaire|bapt[eê]me|communion|fian[cç]ailles|[ée]v[ée]nements? (familia|priv)/i;
const ANNUAIRES = /mariages\.net|zankyou|weddingwire|mariages\.fr|1001mariages|avis-verifies|trustpilot/i;
const RECRUTEMENT = /recrut|nous rejoindre|offres? d'emploi|on embauche/i;

const TRANCHES: Record<string, string> = {
  "00": "0 salarié", "01": "1 ou 2 salariés", "02": "3 à 5 salariés", "03": "6 à 9 salariés",
  "11": "10 à 19 salariés", "12": "20 à 49 salariés", NN: "non renseignée",
};

export function libelleTranche(t: string | null): string {
  return (t && TRANCHES[t]) ?? "inconnue";
}

export function analyser(e: Entreprise, pages: Page[], aujourdhui: Date): Analyse {
  const criteres: Critere[] = [];
  const a_verifier: string[] = [];
  const fiche = `https://annuaire-entreprises.data.gouv.fr/entreprise/${e.siren}`;
  const ajouter = (critere: string, points: number, preuve: string | null, url: string) =>
    criteres.push(preuve ? { critere, points, preuve, url_preuve: url } : { critere, points: 0, preuve: "", url_preuve: "" });

  // Exclusion : outil de devis / configurateur déjà en ligne.
  for (const p of pages) {
    const x = extrait(p.texte, OUTIL_DEVIS);
    if (x) return { criteres: [], exclusion: `Outil de devis en ligne détecté : « ${x} » (${p.url})`, a_verifier };
  }

  // 1. Menus en PDF / image, ou tarifs sur devis (25)
  let preuve1: [string, string] | null = null;
  for (const p of pages) {
    const lien = p.liens.find((l) => /\.(pdf|jpe?g|png|webp)(\?|$)/i.test(l.href) && (FICHIER_MENU.test(l.texte) || FICHIER_MENU.test(l.href)));
    if (lien) {
      const fichier = decodeURIComponentSur(new URL(lien.href).pathname.split("/").pop() ?? "");
      preuve1 = [lien.texte || fichier, p.url];
      break;
    }
  }
  if (!preuve1) {
    for (const p of pages) {
      const x = extrait(p.texte, SUR_DEVIS);
      if (x) {
        preuve1 = [x, p.url];
        break;
      }
    }
  }
  ajouter("Menus en PDF/image ou tarifs sur devis", 25, preuve1?.[0] ?? null, preuve1?.[1] ?? "");

  // 2. Pas d'outil de devis en ligne, simple formulaire / contact (20)
  // Preuve prise sur la page contact si elle existe ; sinon, seulement une formule explicite
  // (« devis », « contactez-nous »…) sur une autre page.
  const pageContact = pages.find((p) => /contact|devis/i.test(new URL(p.url).pathname));
  const aUnMoyenDeContact = pages.some((p) => /<form\b|mailto:|tel:/i.test(p.html));
  let preuve2: [string, string] | null = null;
  if (aUnMoyenDeContact) {
    for (const p of pageContact ? [pageContact] : pages) {
      const x = extrait(p.texte, pageContact ? APPEL_CONTACT : /devis|contactez|nous contacter/i);
      if (x) {
        preuve2 = [x, p.url];
        break;
      }
    }
  }
  ajouter("Pas d'outil de devis en ligne, simple formulaire", 20, preuve2?.[0] ?? null, preuve2?.[1] ?? "");

  // 3. Mariage / événements privés visibles (20)
  let preuve3: [string, string] | null = null;
  for (const p of pages) {
    const x = extrait(p.texte, MARIAGE);
    if (x) {
      preuve3 = [x, p.url];
      break;
    }
  }
  ajouter("Mariage / événements privés visibles", 20, preuve3?.[0] ?? null, preuve3?.[1] ?? "");

  // 4. Taille estimée 2 à 15 personnes (15) — donnée INSEE ; tout ou rien, doute = 0.
  const tailleOk = e.tranche === "02" || e.tranche === "03";
  ajouter("Taille estimée entre 2 et 15 personnes", 15, tailleOk ? `Tranche d'effectif INSEE : ${libelleTranche(e.tranche)}` : null, fiche);
  if (!tailleOk && (e.tranche === "01" || e.tranche === "11" || e.tranche === "00" || e.tranche === "NN" || !e.tranche)) {
    a_verifier.push(`Taille : tranche INSEE « ${libelleTranche(e.tranche)} », à confirmer`);
  }

  // 5. Annuaires mariage ou avis (10)
  let preuve5: [string, string] | null = null;
  for (const p of pages) {
    const lien = p.liens.find((l) => ANNUAIRES.test(l.href));
    if (lien) {
      preuve5 = [lien.texte ? `${lien.texte} (${lien.href})` : lien.href, p.url];
      break;
    }
    const x = extrait(p.texte, /\b\d{2,}\s+avis\b/i);
    if (x) {
      preuve5 = [x, p.url];
      break;
    }
  }
  ajouter("Présence sur annuaires mariage ou avis nombreux", 10, preuve5?.[0] ?? null, preuve5?.[1] ?? "");

  // 6. Fraîcheur : création < 3 ans, ou recrutement (10)
  let preuve6: [string, string] | null = null;
  if (e.dateCreation) {
    const limite = new Date(aujourdhui);
    limite.setFullYear(limite.getFullYear() - 3);
    if (new Date(e.dateCreation) >= limite) preuve6 = [`Date de création (INSEE) : ${e.dateCreation}`, fiche];
  }
  if (!preuve6) {
    for (const p of pages) {
      const x = extrait(p.texte, RECRUTEMENT);
      if (x) {
        preuve6 = [x, p.url];
        break;
      }
    }
  }
  ajouter("Signal de fraîcheur : création < 3 ans ou recrutement", 10, preuve6?.[0] ?? null, preuve6?.[1] ?? "");

  // Points d'attention pour la relecture humaine (pas d'exclusion automatique).
  const tout = normaliser(pages.map((p) => p.texte).join(" "));
  if (/food ?truck/.test(tout)) a_verifier.push("Mentionne un food truck : activité principale ?");
  if (/plateaux? repas/.test(tout) && !preuve3) a_verifier.push("Plateaux-repas sans événements privés visibles");
  if ((tout.match(/\brestaurant\b/g) ?? []).length >= 5) a_verifier.push("Nombreuses mentions « restaurant » : traiteur en appoint ?");
  const devisEnLigne = pages.map((p) => extrait(p.texte, /devis\b[^.!?]{0,30}\ben ligne|\ben ligne\b[^.!?]{0,30}\bdevis/i)).find(Boolean);
  if (devisEnLigne) a_verifier.push(`Mentionne un devis en ligne (« ${devisEnLigne} ») : simple formulaire ou vrai outil ?`);

  return { criteres, exclusion: null, a_verifier };
}

// --- Enrichissement pour la démo -------------------------------------------------------

// Palettes par défaut de WordPress, Divi, Elementor et Google Maps : pas des couleurs de marque.
const COULEURS_PAR_DEFAUT = new Set([
  "#00d084", "#0693e3", "#9b51e0", "#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#8ed1fc", "#abb8c3", "#f78da7",
  "#2ea3f2", "#e6b2d4", "#006799", "#6ec1e4", "#54595f", "#7a7a7a", "#61ce70", "#4285f4", "#34a853",
  "#fbbc04", "#ea4335", "#1a73e8", "#0073aa", "#00a0d2", "#2271b1", "#135e96",
]);

function estGris(c: string): boolean {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(1 + i, 3 + i), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

export function couleurs(page: Page): string[] {
  const theme = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{6})/i.exec(page.html)?.[1]?.toLowerCase();
  const compte = new Map<string, number>();
  for (const m of page.html.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const c = `#${m[1].toLowerCase()}`;
    if (estGris(c) || COULEURS_PAR_DEFAUT.has(c)) continue;
    compte.set(c, (compte.get(c) ?? 0) + 1);
  }
  const top = [...compte.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const themeOk = theme && !estGris(theme) && !COULEURS_PAR_DEFAUT.has(theme) ? theme : undefined;
  return [...new Set([themeOk, ...top].filter((c): c is string => !!c))].slice(0, 3);
}

export function logo(page: Page): string | null {
  for (const m of page.html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/logo/i.test(m[0])) continue;
    const src = /\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (src && !src.startsWith("data:")) {
      try {
        return new URL(decoderEntites(src), page.url).href;
      } catch {
        // ignoré
      }
    }
  }
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i.exec(page.html)?.[1];
  return og ? new URL(decoderEntites(og), page.url).href : null;
}

/** Angle d'approche sans IA, à partir de la preuve la plus forte. */
export function angleModele(criteres: Critere[]): string {
  const c = (nom: string) => criteres.find((x) => x.critere.startsWith(nom) && x.points > 0);
  const menus = c("Menus");
  if (menus && /\.(pdf|jpe?g|png)|pdf|télécharg|telecharg/i.test(menus.preuve)) {
    return "Vos menus sont en PDF : vos clients doivent vous appeler ou vous écrire pour chiffrer leur événement.";
  }
  if (menus) return "Vos tarifs sont « sur devis » : chaque demande vous coûte un échange avant même de chiffrer.";
  if (c("Mariage")) return "Vous faites du mariage sans outil de devis en ligne : chaque couple doit vous contacter pour obtenir un prix.";
  return "Vos clients ne peuvent pas composer leur menu ni obtenir un prix en ligne : tout passe par un échange manuel.";
}
