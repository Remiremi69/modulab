# Prospection traiteurs (version économique)

Remplace l'agent Managed Agents pour la prospection en volume. **Le code fait tout le travail
mécanique**, et Claude n'intervient qu'en appoint :

| Étape | Qui | Coût |
|---|---|---|
| Liste des petits traiteurs du département (API Recherche d'entreprises, 0 à 19 salariés) | code | gratuit |
| Pré-filtre : siège dans le département, activité 56.21Z, 3 établissements ouverts au plus | code | gratuit |
| Site officiel déduit du nom (`nom-du-traiteur.fr/.com`), vérifié : nom, métier et zone (commune, code postal du département, Lyon/Rhône) | code | gratuit |
| Site introuvable par déduction : recherche web | Claude Haiku 4.5 | ~0,02 $ chacune, plafonné |
| Lecture de l'accueil + pages contact / menus / mariage | code | gratuit |
| Notation sur 100 et preuves (extraits **copiés tels quels** des pages ou données INSEE) | code | gratuit |
| Angle d'approche des prospects ≥ 60 | modèle de phrase fondé sur la meilleure preuve | gratuit |

Les preuves ne peuvent pas être inventées : ce sont des extraits recopiés des pages par le
programme. L'IA ne note rien.

## Lancer

**Double-cliquez sur `Lancer-prospection.cmd`.** À la fin, le dossier `resultats` s'ouvre avec :

- `prospects_AAAA-MM-JJ_HHhMM.csv` : s'ouvre dans Excel (score, nom, site, email, angle, preuves,
  points à vérifier) ;
- `prospects_AAAA-MM-JJ_HHhMM.json` : le même contenu, détaillé.

Prérequis déjà en place sur votre PC : Node.js, les dépendances du dépôt, et `ant auth login`
pour les appels à Claude. Sans connexion ou sans crédit, le script continue sans IA.

## Réglages

Ouvrez `Lancer-prospection.cmd` avec le Bloc-notes et retirez `rem ` devant la ligne voulue :

| Réglage | Défaut | Effet |
|---|---|---|
| `MAX_ANALYSES` | 40 | entreprises analysées par run |
| `RECHERCHES_WEB` | 10 | recherches web Claude pour trouver un site (≈ 0,02 $ chacune, résultats compris) |
| `SANS_IA=1` | – | aucun appel à Claude, coût 0 |
| `DEPARTEMENT` | 69 | département ciblé |

## Mémoire entre les runs

`donnees/prospects_vus.json` liste les SIREN déjà analysés : ils sont ignorés aux runs suivants.
Une entreprise dont le site n'a pas été trouvé **sans** tentative de recherche web n'y est pas
ajoutée, elle sera réessayée. Pour tout réanalyser, supprimez ce fichier.

`resultats/` et `donnees/` restent sur votre PC (ignorés par git).

## Limites connues

- La taille « 2 à 15 personnes » vient de la tranche d'effectif INSEE (3 à 9 salariés = 15 points).
  Les tranches ambiguës (1-2, 10-19, non renseignée) valent 0 et sont signalées dans « à vérifier ».
- Les sites entièrement construits en JavaScript (certains Wix) exposent peu de texte : score
  sous-estimé possible.
- Couleurs : les palettes par défaut (WordPress, Divi, Google Maps) sont ignorées ; à confirmer
  à l'œil avant une démo.
- Restaurant d'abord, food truck, plateaux-repas : signalés dans « à vérifier », pas exclus
  automatiquement. La relecture humaine reste nécessaire avant tout contact.
