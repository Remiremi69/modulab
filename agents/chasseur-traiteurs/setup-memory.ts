// ONE-TIME SETUP — crée le memory store qui garde prospects_vus.json d'un run à l'autre.
// Usage : npx tsx agents/chasseur-traiteurs/setup-memory.ts
// Puis : export MEMORY_STORE_ID=memstore_...
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

if (process.env.MEMORY_STORE_ID) {
  console.log(`MEMORY_STORE_ID déjà défini (${process.env.MEMORY_STORE_ID}) : rien à faire.`);
  process.exit(0);
}

const store = await client.beta.memoryStores.create({
  name: "prospection-traiteurs",
  description:
    "Mémoire de prospection Limen Partenaires. prospects_vus.json : tableau JSON des SIREN " +
    "de traiteurs déjà analysés lors des runs précédents (à ignorer, puis à compléter).",
});

await client.beta.memoryStores.memories.create(store.id, {
  path: "/prospects_vus.json",
  content: "[]\n",
});

console.log(`export MEMORY_STORE_ID=${store.id}`);
