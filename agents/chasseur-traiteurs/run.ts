// Lance un run de prospection (une session Managed Agents), suit son avancement, télécharge
// les sorties, puis contre-vérifie côté machine 3 preuves prises au hasard.
//
// Prérequis (voir README.md) : AGENT_ID, ENV_ID, MEMORY_STORE_ID.
// Paramètres optionnels :
//   MAX_PROSPECTS   (défaut 15 — run de calibrage ; 30 en régime normal)
//   DEPARTEMENTS    (défaut "69,01,38,42,71")
//   MAX_ITERATIONS  (défaut 3 — cycles évaluation/révision de l'outcome, max 20)
//   KICKOFF         ("outcome" par défaut, "message" pour forcer le repli)
//   VERIF_SAMPLES   (défaut 3 — preuves contre-vérifiées côté machine ; en plus, toute
//                    url_preuve vers un PDF ou une image fait échouer le run)
//
// Usage : npx tsx agents/chasseur-traiteurs/run.ts
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const AGENT_ID = requireEnv("AGENT_ID");
const ENV_ID = requireEnv("ENV_ID");
const MEMORY_STORE_ID = requireEnv("MEMORY_STORE_ID");
const MAX_PROSPECTS = Number(process.env.MAX_PROSPECTS ?? 15);
const DEPARTEMENTS = (process.env.DEPARTEMENTS ?? "69,01,38,42,71").split(",").map((d) => d.trim());
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? 3);
const KICKOFF = process.env.KICKOFF ?? "outcome";
const VERIF_SAMPLES = Number(process.env.VERIF_SAMPLES ?? 3);
// Une url_preuve vers un de ces fichiers est refusée : toute preuve vient d'une page HTML.
const MEDIA = /\.(pdf|jpe?g|png|gif|webp|svg|avif)(?:[?#]|$)/i;

const RUBRIC = fs.readFileSync(path.join(import.meta.dirname, "rubric.md"), "utf8");
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris" }).format(new Date());

const client = new Anthropic();

const description =
  `Run de prospection du ${today}. Départements : ${DEPARTEMENTS.join(", ")}. ` +
  `Nombre maximum de prospects analysés (notés + exclus) : ${MAX_PROSPECTS}. ` +
  `Produis /mnt/session/outputs/prospects_${today}.json et ` +
  `/mnt/session/outputs/verification_preuves.json, puis mets à jour prospects_vus.json ` +
  `dans le memory store.`;

// --- 1. Session -----------------------------------------------------------------------
const session = await client.beta.sessions.create({
  agent: AGENT_ID,
  environment_id: ENV_ID,
  title: `Prospection traiteurs ${today}`,
  resources: [
    {
      type: "memory_store",
      memory_store_id: MEMORY_STORE_ID,
      access: "read_write",
      instructions: "Contient prospects_vus.json (SIREN déjà analysés). Lis-le au début, complète-le à la fin.",
    },
  ],
});
console.log(`Session ${session.id}`);
console.log(`Suivi en direct : https://platform.claude.com/workspaces/default/sessions/${session.id}\n`);

// --- 2. Stream d'abord, puis lancement -------------------------------------------------
const seen = new Set<string>();
let stream = await client.beta.sessions.events.stream(session.id);
await kickoff();

// --- 3. Boucle jusqu'à l'arrêt réel de la session ---------------------------------------
while (true) {
  let done = false;
  for await (const event of stream) {
    // Aperçus de streaming (event_start / event_delta) : l'événement complet suit.
    if (event.type === "event_start" || event.type === "event_delta") continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (handle(event)) {
      done = true;
      break;
    }
  }
  if (done) break;
  // Le stream s'est fermé sans état terminal : on rattrape l'historique, puis on rouvre.
  console.log("\n[stream interrompu — reconnexion]");
  stream = await client.beta.sessions.events.stream(session.id);
  let caughtUpDone = false;
  for await (const event of client.beta.sessions.events.list(session.id)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (handle(event)) caughtUpDone = true;
  }
  if (caughtUpDone) break;
}

const final = await client.beta.sessions.retrieve(session.id);
for (const ev of final.outcome_evaluations ?? []) console.log(`Outcome ${ev.outcome_id} : ${ev.result}`);

// --- 4. Récupération des sorties --------------------------------------------------------
// Les fichiers sont toujours téléchargés avant la contre-vérification : un échec (code 2)
// laisse donc prospects_{date}.json, verification_preuves.json et controle_preuves.json
// dans runs/.
const outDir = path.join("runs", `${today}_${session.id}`);
fs.mkdirSync(outDir, { recursive: true });
const downloaded = new Map<string, string>(); // file_id -> chemin local
const attendus = [/prospects_\d{4}-\d{2}-\d{2}\.json$/, /verification_preuves\.json$/];
const complet = () => attendus.every((re) => [...downloaded.values()].some((p) => re.test(p)));
for (let attempt = 0; attempt < 6 && !complet(); attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 2000)); // délai d'indexation
  for await (const f of client.beta.files.list({ scope_id: session.id, betas: ["managed-agents-2026-04-01"] })) {
    if (downloaded.has(f.id)) continue;
    const resp = await client.beta.files.download(f.id);
    const dest = path.join(outDir, path.basename(f.filename));
    fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    downloaded.set(f.id, dest);
  }
}
const fichiers = [...downloaded.values()];
console.log(`\nFichiers récupérés dans ${outDir} :\n  ${fichiers.join("\n  ") || "(aucun)"}`);

// --- 5. Contre-vérification indépendante des preuves -----------------------------------
const rapportPath = path.join(outDir, "controle_preuves.json");
const prospectsFile = fichiers.find((p) => attendus[0].test(p));
if (!fichiers.some((p) => attendus[1].test(p))) {
  console.warn("Attention : verification_preuves.json absent des sorties de l'agent.");
}
const controle = await controler(prospectsFile);
fs.writeFileSync(
  rapportPath,
  JSON.stringify({ date_run: today, session_id: session.id, fichiers_recuperes: fichiers, ...controle }, null, 2),
);
console.log(`Rapport de contre-vérification : ${rapportPath}`);
if (!controle.ok) for (const m of controle.motifs_echec) console.error(`ÉCHEC : ${m}`);
process.exit(controle.ok ? 0 : prospectsFile ? 2 : 1);

// ======================================================================================

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Variable d'environnement manquante : ${name} (voir agents/chasseur-traiteurs/README.md)`);
    process.exit(1);
  }
  return v;
}

async function kickoff() {
  if (KICKOFF === "outcome") {
    try {
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.define_outcome",
            description,
            rubric: { type: "text", content: RUBRIC },
            max_iterations: MAX_ITERATIONS,
          },
        ],
      });
      console.log("Lancement : outcome + grille de contrôle.\n");
      return;
    } catch (err) {
      // Outcomes indisponibles sur le compte → repli sur un message simple.
      if (!(err instanceof Anthropic.APIError) || ![400, 403, 404].includes(err.status ?? 0)) throw err;
      console.warn(`define_outcome refusé (${err.status} : ${err.message}) → repli sur un message de lancement.\n`);
    }
  }
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text:
              `${description}\n\nAvant de terminer, vérifie toi-même chaque point de cette grille ` +
              `et corrige ce qui ne passe pas :\n\n${RUBRIC}`,
          },
        ],
      },
    ],
  });
  console.log("Lancement : message simple (sans évaluateur séparé).\n");
}

/** Affiche l'événement ; renvoie true quand la session est réellement arrêtée. */
function handle(event: Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent): boolean {
  switch (event.type) {
    case "agent.message":
      for (const block of event.content) if (block.type === "text") process.stdout.write(block.text);
      break;
    case "agent.tool_use":
      process.stdout.write(`\n  · ${event.name}\n`);
      break;
    case "span.outcome_evaluation_end":
      console.log(`\n[évaluation #${event.iteration}] ${event.result} — ${event.explanation}\n`);
      break;
    case "session.error":
      console.error(`\n[erreur session] ${JSON.stringify(event.error)}`);
      break;
    case "session.status_terminated":
      console.log("\n--- session terminée ---");
      return true;
    case "session.status_idle":
      if (event.stop_reason.type === "requires_action") {
        // Aucun outil n'exige d'approbation dans cette config ; si ça arrive, on le signale.
        console.warn("\n[session en attente d'une action utilisateur — voir la Console]");
        return true;
      }
      console.log(`\n--- session au repos (${event.stop_reason.type}) ---`);
      return true;
  }
  return false;
}

type Critere = { critere: string; points: number; preuve: string; url_preuve: string };
type Prospect = { nom: string; criteres: Critere[] };
type Resultat = Critere & {
  nom: string;
  statut: "ok" | "echec" | "injoignable";
  motif: string | null;
};
type Controle = { ok: boolean; motifs_echec: string[]; echecs: Resultat[]; resultats: Resultat[] };

async function controler(fichier: string | undefined): Promise<Controle> {
  if (!fichier) return controleEchoue("fichier prospects_{date}.json introuvable dans les sorties");
  let data: { prospects: Prospect[] };
  try {
    data = JSON.parse(fs.readFileSync(fichier, "utf8"));
  } catch (err) {
    return controleEchoue(`prospects JSON illisible : ${(err as Error).message}`);
  }
  return verifierPreuves(data);
}

function controleEchoue(motif: string): Controle {
  return { ok: false, motifs_echec: [motif], echecs: [], resultats: [] };
}

function versFichier(url: string): boolean {
  try {
    return MEDIA.test(new URL(url).pathname);
  } catch {
    return MEDIA.test(url);
  }
}

async function verifierPreuves(data: { prospects: Prospect[] }): Promise<Controle> {
  const candidats = (data.prospects ?? []).flatMap((p) =>
    (p.criteres ?? []).filter((c) => c.points > 0 && c.preuve && c.url_preuve).map((c) => ({ nom: p.nom, ...c })),
  );
  const resultats: Resultat[] = [];
  const noter = (c: (typeof candidats)[number], statut: Resultat["statut"], motif: string | null) => {
    resultats.push({ ...c, statut, motif });
    const icone = { ok: "✓", echec: "✗", injoignable: "?" }[statut];
    console.log(`  ${icone} ${c.nom} — ${c.critere} : « ${c.preuve} » (${c.url_preuve})${motif ? ` — ${motif}` : ""}`);
  };

  // Règle : toute preuve vient d'une page HTML — aucune url_preuve vers un PDF ou une image.
  // Contrôlé sur toutes les preuves, pas seulement l'échantillon.
  console.log(`\nContrôle des url_preuve (${candidats.length} preuves) :`);
  const versMedia = candidats.filter((c) => versFichier(c.url_preuve));
  for (const c of versMedia) noter(c, "echec", "url_preuve pointe vers un PDF ou une image, pas une page HTML");

  const echantillon = candidats.filter((c) => !versMedia.includes(c));
  shuffle(echantillon);
  console.log(`Contre-vérification de ${VERIF_SAMPLES} preuves tirées au hasard (sur ${echantillon.length}) :`);
  let verifiees = 0;
  for (const c of echantillon) {
    if (verifiees >= VERIF_SAMPLES) break;
    const page = await fetchPage(c.url_preuve);
    if (page === null) {
      noter(c, "injoignable", "page injoignable, tirage suivant");
      continue;
    }
    verifiees++;
    if (page === "media") noter(c, "echec", "l'URL renvoie un PDF ou une image, pas une page HTML");
    else if (!normaliser(page).includes(normaliser(c.preuve))) noter(c, "echec", "citation introuvable sur la page");
    else noter(c, "ok", null);
  }

  const echecs = resultats.filter((r) => r.statut === "echec");
  const motifs_echec: string[] = [];
  if (versMedia.length > 0) {
    motifs_echec.push(`${versMedia.length} preuve(s) pointent vers un PDF ou une image au lieu d'une page HTML`);
  }
  const echecsEchantillon = echecs.length - versMedia.length;
  if (echecsEchantillon > 0) motifs_echec.push(`${echecsEchantillon} preuve(s) de l'échantillon non retrouvée(s)`);
  if (verifiees < VERIF_SAMPLES) {
    motifs_echec.push(`seulement ${verifiees} preuve(s) vérifiable(s) sur ${VERIF_SAMPLES} demandées`);
  }
  const ok = motifs_echec.length === 0;
  if (ok) console.log("Preuves contre-vérifiées : OK.");
  return { ok, motifs_echec, echecs, resultats };
}

/**
 * Texte visible de la page HTML, suivi des noms de fichiers cités dans ses liens (href/src),
 * pour qu'une preuve « nom du fichier PDF » soit retrouvable. "media" si l'URL renvoie un
 * PDF/une image ; null si la page est injoignable.
 */
async function fetchPage(url: string): Promise<string | "media" | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "Mozilla/5.0 (verification-preuves Limen)" },
    });
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") ?? "";
    if (/pdf|image\//i.test(type)) return "media";
    if (!type.includes("html")) return null;
    const html = await resp.text();
    const fichiers = [...html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => {
      const nom = m[1].split(/[?#]/)[0].split("/").pop() ?? "";
      try {
        return decodeURIComponent(nom);
      } catch {
        return nom;
      }
    });
    const texte = html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;|&apos;/g, "'")
      .replace(/&quot;|&laquo;|&raquo;/g, '"')
      .replace(/&euro;/g, "€")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    return [texte, ...fichiers].join(" | ");
  } catch {
    return null;
  }
}

/** « Au mot près ou quasi » : on ignore casse, accents, ponctuation et espaces. */
function normaliser(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
