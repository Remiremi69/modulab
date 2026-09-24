// Lance un run de prospection (une session Managed Agents), suit son avancement, télécharge
// les sorties, puis contre-vérifie côté machine 3 preuves prises au hasard.
//
// Prérequis (voir README.md) : AGENT_ID, ENV_ID, MEMORY_STORE_ID.
// Paramètres optionnels :
//   MAX_PROSPECTS   (défaut 15 — run de calibrage ; 30 en régime normal)
//   DEPARTEMENTS    (défaut "69,01,38,42,71")
//   MAX_ITERATIONS  (défaut 3 — cycles évaluation/révision de l'outcome, max 20)
//   KICKOFF         ("outcome" par défaut, "message" pour forcer le repli)
//   VERIF_SAMPLES   (défaut 3 — preuves contre-vérifiées côté machine)
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
const outDir = path.join("runs", `${today}_${session.id}`);
fs.mkdirSync(outDir, { recursive: true });
let downloaded: string[] = [];
for (let attempt = 0; attempt < 4 && downloaded.length === 0; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 2000)); // délai d'indexation
  for await (const f of client.beta.files.list({ scope_id: session.id, betas: ["managed-agents-2026-04-01"] })) {
    const resp = await client.beta.files.download(f.id);
    const dest = path.join(outDir, path.basename(f.filename));
    fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    downloaded.push(dest);
  }
}
console.log(`\nFichiers récupérés dans ${outDir} :\n  ${downloaded.join("\n  ") || "(aucun)"}`);

const prospectsFile = downloaded.find((p) => /prospects_\d{4}-\d{2}-\d{2}\.json$/.test(p));
if (!prospectsFile) {
  console.error("ÉCHEC : fichier prospects_{date}.json introuvable dans les sorties.");
  process.exit(1);
}

// --- 5. Contre-vérification indépendante des preuves -----------------------------------
const ok = await verifierPreuves(JSON.parse(fs.readFileSync(prospectsFile, "utf8")));
process.exit(ok ? 0 : 2);

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

async function verifierPreuves(data: { prospects: Prospect[] }): Promise<boolean> {
  const candidats = data.prospects.flatMap((p) =>
    (p.criteres ?? []).filter((c) => c.points > 0 && c.preuve && c.url_preuve).map((c) => ({ nom: p.nom, ...c })),
  );
  shuffle(candidats);
  console.log(`\nContre-vérification de ${VERIF_SAMPLES} preuves tirées au hasard (sur ${candidats.length}) :`);

  let verifiees = 0;
  let echecs = 0;
  for (const c of candidats) {
    if (verifiees >= VERIF_SAMPLES) break;
    const page = await fetchTexte(c.url_preuve);
    if (page === null) {
      console.log(`  ? ${c.nom} — ${c.critere} : page non lisible automatiquement (${c.url_preuve}), tirage suivant`);
      continue;
    }
    verifiees++;
    const trouvee = normaliser(page).includes(normaliser(c.preuve));
    if (!trouvee) echecs++;
    console.log(`  ${trouvee ? "✓" : "✗"} ${c.nom} — ${c.critere} : « ${c.preuve} » (${c.url_preuve})`);
  }

  if (verifiees < VERIF_SAMPLES) {
    console.error(`ÉCHEC : seulement ${verifiees} preuve(s) vérifiable(s) sur ${VERIF_SAMPLES} demandées.`);
    return false;
  }
  if (echecs > 0) {
    console.error(`ÉCHEC : ${echecs} citation(s) introuvable(s) sur la page indiquée.`);
    return false;
  }
  console.log("Preuves contre-vérifiées : OK.");
  return true;
}

async function fetchTexte(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "Mozilla/5.0 (verification-preuves Limen)" },
    });
    if (!resp.ok || !(resp.headers.get("content-type") ?? "").includes("html")) return null;
    return (await resp.text())
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;|&apos;/g, "'")
      .replace(/&quot;|&laquo;|&raquo;/g, '"')
      .replace(/&euro;/g, "€")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
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
