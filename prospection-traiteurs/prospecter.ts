// Prospection des traiteurs — version économique.
// Le code fait tout le travail mécanique (API gouv, sites, preuves, scores).
// Claude Haiku n'intervient que pour : trouver un site introuvable par déduction du nom
// (recherche web, plafonnée) et rédiger l'angle d'approche des prospects ≥ 60.
//
// Lancement : double-clic sur Lancer-prospection.cmd, ou
//   npx.cmd tsx prospection-traiteurs/prospecter.ts
//
// Réglages (variables d'environnement, toutes facultatives) :
//   DEPARTEMENT     69 par défaut
//   MAX_ANALYSES    nombre maximum d'entreprises analysées par run (défaut 40)
//   RECHERCHES_WEB  recherches web Claude autorisées pour trouver un site (défaut 10, ~0,01 $ chacune)
//   SANS_IA=1       aucun appel à Claude (coût 0 ; sites non devinés = ignorés, angles modèles)
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import {
  analyser, angleModele, couleurs, logo, pagesACharger, siteCorrespond, telecharger,
  urlsCandidates, type Critere, type Entreprise, type Page,
} from "./analyse.ts";

const DEPARTEMENT = process.env.DEPARTEMENT ?? "69";
const MAX_ANALYSES = Number(process.env.MAX_ANALYSES ?? 40);
let recherchesRestantes = Number(process.env.RECHERCHES_WEB ?? 10);
let iaActive = process.env.SANS_IA !== "1";
const API_BASE = process.env.API_BASE ?? "https://recherche-entreprises.api.gouv.fr";
const MODELE = "claude-haiku-4-5";

const DIR = import.meta.dirname;
const DOSSIER_RESULTATS = path.join(DIR, "resultats");
const FICHIER_VUS = path.join(DIR, "donnees", "prospects_vus.json");
const aujourdhui = new Date();
const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(aujourdhui);
const heure = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })
  .format(aujourdhui)
  .replace(":", "h");

const client = new Anthropic();
const conso = { entree: 0, sortie: 0, recherches: 0 };

// --- 1. Liste des petits traiteurs via l'API Recherche d'entreprises ----------------------

type ResultatApi = {
  siren: string;
  nom_complet: string;
  activite_principale?: string;
  date_creation?: string | null;
  tranche_effectif_salarie?: string | null;
  nombre_etablissements_ouverts?: number | null;
  siege?: { departement?: string; libelle_commune?: string; nom_commercial?: string | null; liste_enseignes?: string[] | null } | null;
};

async function appelApi(page: number): Promise<{ total: number; resultats: ResultatApi[] }> {
  const url =
    `${API_BASE}/search?activite_principale=56.21Z&departement=${DEPARTEMENT}&etat_administratif=A` +
    `&tranche_effectif_salarie=00,01,02,03,11&per_page=25&page=${page}`;
  for (let essai = 1; essai <= 5; essai++) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (resp.status === 429) {
      const attente = Number(resp.headers.get("retry-after") ?? 0) * 1000 || 3000 * essai;
      console.log(`  API : trop de requêtes, nouvelle tentative dans ${Math.round(attente / 1000)} s…`);
      await pause(attente);
      continue;
    }
    if (!resp.ok) throw new Error(`API Recherche d'entreprises : HTTP ${resp.status} sur ${url}`);
    const d = (await resp.json()) as { total_results: number; total_pages: number; results: ResultatApi[] };
    return { total: d.total_results, resultats: d.results ?? [] };
  }
  throw new Error("API Recherche d'entreprises : toujours « trop de requêtes » après 5 tentatives.");
}

async function listerEntreprises(): Promise<{ retenues: Entreprise[]; total: number; ecartees: number }> {
  const retenues: Entreprise[] = [];
  let total = 0;
  let ecartees = 0;
  for (let page = 1; ; page++) {
    const r = await appelApi(page);
    total = r.total;
    for (const x of r.resultats) {
      const s = x.siege ?? {};
      const ok =
        x.activite_principale === "56.21Z" &&
        (x.nombre_etablissements_ouverts ?? 0) <= 3 &&
        s.departement === DEPARTEMENT;
      if (!ok) {
        ecartees++;
        continue;
      }
      const noms = [x.nom_complet, s.nom_commercial ?? "", ...(s.liste_enseignes ?? [])].filter(Boolean);
      retenues.push({
        siren: x.siren,
        nom: s.nom_commercial || s.liste_enseignes?.[0] || x.nom_complet,
        noms: [...new Set(noms)],
        commune: s.libelle_commune ?? "",
        dateCreation: x.date_creation ?? null,
        tranche: x.tranche_effectif_salarie ?? null,
        nbEtablissementsOuverts: x.nombre_etablissements_ouverts ?? 0,
      });
    }
    if (page * 25 >= total || r.resultats.length === 0) break;
    await pause(1200); // l'API limite le débit : on reste très en dessous
  }
  return { retenues, total, ecartees };
}

// --- 2. Trouver le site officiel ------------------------------------------------------------

/** SIREN sans site dont la recherche web n'a pas été tentée : à réessayer au prochain run. */
const aReessayer = new Set<string>();

async function trouverSite(e: Entreprise): Promise<{ page: Page; via: string } | null> {
  for (const url of urlsCandidates(e)) {
    const page = await telecharger(url, 8000);
    if (page && siteCorrespond(page, e)) return { page, via: "déduit du nom" };
  }
  if (!iaActive || recherchesRestantes <= 0) {
    aReessayer.add(e.siren);
    return null;
  }
  recherchesRestantes--;
  const url = await rechercheWeb(e);
  if (!url) return null;
  const page = await telecharger(url);
  return page && siteCorrespond(page, e) ? { page, via: "recherche web" } : null;
}

async function rechercheWeb(e: Entreprise): Promise<string | null> {
  try {
    const rep = await client.messages.create({
      model: MODELE,
      max_tokens: 300,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      messages: [
        {
          role: "user",
          content:
            `Trouve le site web officiel du traiteur « ${e.nom} » (${e.noms.join(" / ")}), situé à ${e.commune} (${DEPARTEMENT}). ` +
            `Réponds uniquement par l'URL de sa page d'accueil, ou par AUCUN s'il n'a pas de site propre ` +
            `(une page d'annuaire, Facebook ou Instagram ne compte pas).`,
        },
      ],
    });
    compter(rep.usage);
    const texte = rep.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    const url = /https?:\/\/[^\s)>\]"']+/.exec(texte)?.[0];
    if (!url || /facebook|instagram|pagesjaunes|mariages\.net|linkedin|societe\.com|annuaire/i.test(url)) return null;
    return url;
  } catch (err) {
    return erreurIa(err);
  }
}

// --- 3. Angle d'approche (IA) -----------------------------------------------------------------

async function angleIa(nom: string, criteres: Critere[]): Promise<string | null> {
  const preuves = criteres.filter((c) => c.points > 0).map((c) => `- ${c.critere} : « ${c.preuve} »`).join("\n");
  try {
    const rep = await client.messages.create({
      model: MODELE,
      max_tokens: 200,
      system:
        "Tu rédiges une phrase d'accroche de prospection pour le Composeur, un configurateur en ligne où " +
        "le client compose son menu et obtient un devis. Une seule phrase, en français, au vouvoiement, " +
        "fondée uniquement sur les preuves fournies. N'invente aucun fait.",
      messages: [{ role: "user", content: `Traiteur : ${nom}\nPreuves :\n${preuves}\n\nÉcris la phrase.` }],
    });
    compter(rep.usage);
    const t = rep.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    return t || null;
  } catch (err) {
    return erreurIa(err);
  }
}

function compter(u: Anthropic.Usage) {
  conso.entree += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  conso.sortie += u.output_tokens;
  conso.recherches += u.server_tool_use?.web_search_requests ?? 0;
}

function erreurIa(err: unknown): null {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.warn("  Claude inaccessible (authentification) : suite du run sans IA. Lancez « ant auth login ».");
    iaActive = false;
  } else if (err instanceof Anthropic.APIError && /credit|billing|balance/i.test(err.message)) {
    console.warn("  Crédit Claude épuisé : suite du run sans IA.");
    iaActive = false;
  } else if (err instanceof Anthropic.APIError) {
    console.warn(`  Appel Claude en échec (${err.status}) : ${err.message}`);
  } else {
    throw err;
  }
  return null;
}

// --- 4. Programme principal ---------------------------------------------------------------------

type Prospect = {
  nom: string; siren: string; commune: string; site: string; trouve_via: string; email_public: string | null;
  score: number; criteres: Critere[]; couleurs: string[]; logo_url: string | null; angle: string; a_verifier: string[];
};

const vus = new Set<string>(lireJson<string[]>(FICHIER_VUS, []));
console.log(`Prospection traiteurs — département ${DEPARTEMENT} — ${date}`);
console.log(`IA : ${iaActive ? `oui (${MODELE}, ${recherchesRestantes} recherches web max)` : "non"}\n`);

console.log("1/3 Liste des traiteurs (API Recherche d'entreprises)…");
const { retenues, total, ecartees } = await listerEntreprises();
const aAnalyser = retenues.filter((e) => !vus.has(e.siren)).slice(0, MAX_ANALYSES);
console.log(
  `  ${total} traiteurs de 0 à 19 salariés dans le ${DEPARTEMENT} ; ${ecartees} écartés au pré-filtre ` +
    `(siège hors ${DEPARTEMENT}, plus de 3 établissements ou autre activité principale) ; ` +
    `${retenues.length - aAnalyser.length} déjà vus ou hors quota ; ${aAnalyser.length} à analyser.\n`,
);

console.log("2/3 Sites et notation…");
const prospects: Prospect[] = [];
const exclus: { nom: string; siren: string | null; raison: string }[] = [];
await parLots(aAnalyser, 5, async (e) => {
  const site = await trouverSite(e);
  if (!site) {
    const raison = aReessayer.has(e.siren) ? "Pas de site trouvé (recherche web non tentée : réessayé au prochain run)" : "Pas de site trouvé";
    exclus.push({ nom: e.nom, siren: e.siren, raison });
    console.log(`  – ${e.nom} : ${raison.toLowerCase()}`);
    return;
  }
  const autres = (await Promise.all(pagesACharger(site.page).map((u) => telecharger(u)))).filter((p): p is Page => !!p);
  const pages = [site.page, ...autres];
  const a = analyser(e, pages, aujourdhui);
  if (a.exclusion) {
    exclus.push({ nom: e.nom, siren: e.siren, raison: a.exclusion });
    console.log(`  ✗ ${e.nom} : ${a.exclusion}`);
    return;
  }
  const score = a.criteres.reduce((s, c) => s + c.points, 0);
  const email = emailPublic(pages);
  prospects.push({
    nom: e.nom, siren: e.siren, commune: e.commune, site: site.page.url, trouve_via: site.via, email_public: email,
    score, criteres: a.criteres, couleurs: score >= 60 ? couleurs(site.page) : [], logo_url: score >= 60 ? logo(site.page) : null,
    angle: "", a_verifier: a.a_verifier,
  });
  console.log(`  ✓ ${e.nom} : ${score}/100 (${site.page.url})`);
});

console.log("\n3/3 Angles d'approche (prospects ≥ 60)…");
prospects.sort((a, b) => b.score - a.score);
for (const p of prospects.filter((p) => p.score >= 60)) {
  p.angle = (iaActive ? await angleIa(p.nom, p.criteres) : null) ?? angleModele(p.criteres);
}

// --- 5. Sorties -----------------------------------------------------------------------------------

fs.mkdirSync(DOSSIER_RESULTATS, { recursive: true });
fs.mkdirSync(path.dirname(FICHIER_VUS), { recursive: true });
const base = path.join(DOSSIER_RESULTATS, `prospects_${date}_${heure}`);
const coutUsd = (conso.entree * 1 + conso.sortie * 5) / 1e6 + conso.recherches * 0.01;
fs.writeFileSync(
  `${base}.json`,
  JSON.stringify(
    { date_run: date, departement: DEPARTEMENT, traiteurs_api: total, exclus_prefiltre: ecartees, cout_ia_estime_usd: arrondi(coutUsd), prospects, exclus },
    null,
    2,
  ),
);
fs.writeFileSync(`${base}.csv`, csv(prospects));
for (const e of aAnalyser) if (!aReessayer.has(e.siren)) vus.add(e.siren);
fs.writeFileSync(FICHIER_VUS, JSON.stringify([...vus].sort(), null, 2));

console.log(`\nTerminé : ${aAnalyser.length} analysés, ${prospects.length} notés, ${exclus.length} exclus.`);
console.log(`Coût Claude estimé : ${arrondi(coutUsd)} $ (${conso.entree} tokens en entrée, ${conso.sortie} en sortie, ${conso.recherches} recherches web)`);
console.log("Top 10 :");
for (const p of prospects.slice(0, 10)) console.log(`  ${String(p.score).padStart(3)}  ${p.nom} — ${p.site}${p.angle ? `\n       ${p.angle}` : ""}`);
console.log(`\nFichiers : ${base}.csv (Excel) et ${base}.json`);

// --- Utilitaires ------------------------------------------------------------------------------------

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function arrondi(n: number) {
  return Math.round(n * 100) / 100;
}

function lireJson<T>(fichier: string, defaut: T): T {
  try {
    return JSON.parse(fs.readFileSync(fichier, "utf8")) as T;
  } catch {
    return defaut;
  }
}

async function parLots<T>(items: T[], taille: number, f: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += taille) await Promise.all(items.slice(i, i + taille).map(f));
}

/** Première adresse email publiée sur le site (lien mailto:). */
function emailPublic(pages: Page[]): string | null {
  for (const p of pages) {
    for (const m of p.html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
      let email: string;
      try {
        email = decodeURIComponent(m[1]).toLowerCase();
      } catch {
        continue;
      }
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return email;
    }
  }
  return null;
}

function csv(liste: Prospect[]): string {
  const cellule = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const entetes = ["score", "nom", "commune", "site", "email", "siren", "angle", "a_verifier", "preuves"];
  const lignes = liste.map((p) =>
    [
      p.score, p.nom, p.commune, p.site, p.email_public, p.siren, p.angle, p.a_verifier.join(" ; "),
      p.criteres.filter((c) => c.points > 0).map((c) => `${c.critere} (${c.points}) : « ${c.preuve} » ${c.url_preuve}`).join("\n"),
    ].map(cellule).join(";"),
  );
  return "﻿" + [entetes.join(";"), ...lignes].join("\r\n") + "\r\n"; // BOM + « ; » : s'ouvre bien dans Excel FR
}

