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
- `controle_preuves.json` : le rapport de la contre-vérification faite par `run.ts`
  (`ok`, `motifs_echec`, `echecs` avec la preuve, l'URL et le motif de chaque échec, et
  `resultats` pour toutes les preuves contrôlées)

Ces fichiers sont téléchargés **avant** la contre-vérification. Ils restent donc dans `runs/`
même quand le run sort en échec.

## Lancer depuis un PC Windows

### Prérequis

1. **Node.js 20.11 ou plus récent** (LTS) :
   `winget install OpenJS.NodeJS.LTS`, puis rouvrez le terminal et vérifiez avec `node -v`.
2. **Git** (pour cloner le dépôt) : `winget install Git.Git`.
3. **PowerShell 7** (recommandé : il envoie l'UTF-8 correctement aux commandes, donc les
   accents du prompt restent intacts) : `winget install Microsoft.PowerShell`, puis ouvrez
   « PowerShell 7 » (`pwsh`), idéalement dans Windows Terminal.
4. **CLI `ant`** : téléchargez l'archive Windows (`windows_amd64`, ou `windows_arm64` sur un
   PC ARM) depuis https://github.com/anthropics/anthropic-cli/releases, extrayez `ant.exe`
   dans un dossier (ex. `C:\Tools\ant`) et ajoutez ce dossier au `PATH` de votre compte.
   Vérifiez avec `ant --version`.
5. **Authentification** : `ant auth login` (ouvre le navigateur ; le profil est enregistré
   dans `%APPDATA%\Anthropic` et lu automatiquement par le SDK). Vérifiez avec
   `ant auth status`. Ne définissez pas en plus `ANTHROPIC_API_KEY` : elle masquerait le profil.
6. **Réseau** : `run.ts` télécharge lui-même 3 pages de preuve depuis votre PC. Derrière un
   proxy d'entreprise, ces téléchargements peuvent échouer. Le script tente alors d'autres
   tirages et échoue s'il n'en vérifie pas assez.

### Commandes (PowerShell 7)

PowerShell ne gère pas la redirection `<`, on passe donc le YAML par un pipe :

```powershell
git clone https://github.com/Remiremi69/modulab.git; cd modulab
npm install
cd agents\chasseur-traiteurs

$OutputEncoding = [System.Text.UTF8Encoding]::new()   # accents du prompt en UTF-8
$env:AGENT_ID = Get-Content -Raw -Encoding utf8 chasseur-traiteurs.agent.yaml | ant beta:agents create --transform id -r
$env:ENV_ID   = Get-Content -Raw -Encoding utf8 chasseur-traiteurs.environment.yaml | ant beta:environments create --transform id -r
npx tsx setup-memory.ts                               # affiche l'ID memstore_...
$env:MEMORY_STORE_ID = "memstore_..."                 # collez l'ID affiché
"AGENT_ID=$env:AGENT_ID ENV_ID=$env:ENV_ID"           # notez ces IDs

cd ..\..
npx tsx agents/chasseur-traiteurs/run.ts
```

Pour les runs suivants, dans un nouveau terminal, redéfinissez les trois variables, puis
changez les paramètres de la même façon :

```powershell
$env:AGENT_ID = "agent_..."; $env:ENV_ID = "env_..."; $env:MEMORY_STORE_ID = "memstore_..."
$env:MAX_PROSPECTS = "30"; npx tsx agents/chasseur-traiteurs/run.ts
Remove-Item Env:MAX_PROSPECTS                         # revenir à la valeur par défaut (15)
```

Pour les garder d'une session à l'autre :
`[Environment]::SetEnvironmentVariable("AGENT_ID", "agent_...", "User")` (idem pour
`ENV_ID` et `MEMORY_STORE_ID`), puis rouvrez le terminal.

Le code de sortie du run se lit avec `$LASTEXITCODE` : `0` = OK, `1` = pas de fichier de
sortie, `2` = contre-vérification des preuves en échec.

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
     Les pages injoignables sont remplacées par un autre tirage.
   - Toute preuve doit venir d'une page HTML. Pour « menus en PDF » et « tarifs sur demande »,
     la preuve est le texte du lien ou le nom du fichier sur la page, jamais le contenu du PDF.
     `run.ts` fait échouer le run dès qu'une `url_preuve` pointe vers un PDF ou une image.
3. **Repli** : si `define_outcome` est refusé (400/403/404), le script relance avec un simple
   `user.message` contenant la grille comme checklist d'auto-vérification. Dans ce cas, aucun
   évaluateur séparé n'intervient, mais la contre-vérification de `run.ts` s'applique toujours.

## Mémoire

`prospects_vus.json` vit dans le memory store `prospection-traiteurs`, pas dans le dépôt.
Chaque écriture est versionnée (voir la Console, onglet Memory, pour consulter ou revenir en
arrière). Pour repartir de zéro après le calibrage, remettez son contenu à `[]` depuis la
Console.
