# Chasseur-Analyste Traiteurs (Managed Agents)

Agent de prospection Limen Partenaires : trouve des traiteurs (69, 01, 38, 42, 71), les note
sur 100 avec preuves, et produit `prospects_{date}.json`. Il ne contacte personne.

| Fichier | Rôle |
|---|---|
| `chasseur-traiteurs.agent.yaml` | Agent versionné (modèle, outils, prompt système) |
| `chasseur-traiteurs.environment.yaml` | Sandbox cloud, réseau sans restriction |
| `rubric.md` | Grille de contrôle (9 critères) de l'outcome |
| `setup-memory.ts` | Crée le memory store qui garde `prospects_vus.json` entre les runs |
| `run.ts` | Lance un run, suit l'avancement, télécharge les sorties, contre-vérifie 3 preuves |

## 1. Installation (une seule fois)

Prérequis : Node ≥ 20.11, le CLI [`ant`](https://github.com/anthropics/anthropic-cli/releases),
et une authentification (`ant auth login`, ou `ANTHROPIC_API_KEY`).

```sh
npm install
cd agents/chasseur-traiteurs

AGENT_ID=$(ant beta:agents create < chasseur-traiteurs.agent.yaml --transform id -r)
ENV_ID=$(ant beta:environments create < chasseur-traiteurs.environment.yaml --transform id -r)
npx tsx setup-memory.ts          # affiche : export MEMORY_STORE_ID=memstore_...

echo "export AGENT_ID=$AGENT_ID ENV_ID=$ENV_ID"   # gardez ces 3 IDs (ex. dans un .env)
```

Pour modifier le prompt plus tard, éditez le YAML puis :

```sh
ant beta:agents update --agent-id "$AGENT_ID" --version N < chasseur-traiteurs.agent.yaml
```

(`N` = version actuelle de l'agent ; chaque mise à jour crée une nouvelle version.)

## 2. Lancer un run

```sh
export AGENT_ID=... ENV_ID=... MEMORY_STORE_ID=...
npx tsx agents/chasseur-traiteurs/run.ts                 # calibrage : 15 prospects
MAX_PROSPECTS=30 npx tsx agents/chasseur-traiteurs/run.ts
DEPARTEMENTS=69,38 MAX_PROSPECTS=10 npx tsx agents/chasseur-traiteurs/run.ts
KICKOFF=message npx tsx agents/chasseur-traiteurs/run.ts # force le repli sans outcome
```

Le script affiche le lien Console pour suivre la session en direct. Les sorties arrivent dans
`runs/{date}_{session}/` :

- `prospects_{date}.json` : prospects triés + exclus
- `verification_preuves.json` : les 3 preuves ou plus retéléchargées par l'agent

## Comment la qualité est contrôlée

1. **Outcome** : la session démarre par `user.define_outcome` avec `rubric.md`. Un évaluateur
   séparé note chaque itération. En cas d'écart, l'agent corrige, jusqu'à `MAX_ITERATIONS`
   (3 par défaut).
2. **Critère 9, en deux couches.** L'évaluateur de l'outcome **n'a pas accès au web**, donc
   il ne peut pas rouvrir les URL lui-même.
   - L'agent tire au hasard au moins 3 preuves, retélécharge les pages et consigne un extrait
     dans `verification_preuves.json`. L'évaluateur contrôle cette cohérence.
   - `run.ts` fait ensuite **sa propre** vérification indépendante. Il tire 3 preuves au hasard,
     télécharge les pages depuis votre machine et cherche la citation, en ignorant casse,
     accents, ponctuation et espaces. Code de sortie `2` si une citation est introuvable.
     Les pages non lisibles automatiquement (PDF, erreurs) sont remplacées par un autre tirage.
3. **Repli** : si `define_outcome` est refusé (400/403/404), le script relance avec un simple
   `user.message` contenant la grille comme checklist d'auto-vérification. Dans ce cas, aucun
   évaluateur séparé n'intervient, mais la contre-vérification de `run.ts` s'applique toujours.

## Mémoire

`prospects_vus.json` vit dans le memory store `prospection-traiteurs`, pas dans le dépôt.
Chaque écriture est versionnée (voir la Console, onglet Memory, pour consulter ou revenir en
arrière). Pour repartir de zéro après le calibrage, remettez son contenu à `[]` depuis la
Console.
