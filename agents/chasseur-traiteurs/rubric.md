# Grille de contrôle — run Chasseur-Analyste Traiteurs

Grille de départ, à ajuster après le run de calibrage. Chaque critère est noté séparément ;
un seul critère non satisfait = révision.

1. `/mnt/session/outputs/prospects_{date}.json` existe, est un JSON valide et suit exactement
   le schéma demandé (`date_run`, `prospects[]`, `exclus[]`, champs de chaque prospect).
2. `prospects` est trié par `score` décroissant, et chaque `score` est égal à la somme des
   `points` de ses `criteres`. Aucun critère ne dépasse son barème (25/20/20/15/10/10).
3. Chaque critère à points > 0 a une `preuve` non vide et une `url_preuve` située sur le
   domaine du prospect ou sur une source nommée (annuaire mariage, API recherche-entreprises).
   Aucune `url_preuve` ne pointe vers un PDF ou une image (`.pdf`, `.jpg`, `.png`, etc.) :
   pour « menus en PDF / en image » et « tarifs sur demande », la preuve est le texte du lien
   ou le nom du fichier tel qu'il apparaît sur la page HTML, et `url_preuve` est cette page.
4. Aucun prospect hors des départements demandés dans le message de lancement, et aucun
   SIREN présent dans `prospects_vus.json` au démarrage du run n'apparaît dans la sortie.
5. Le nombre total analysé (prospects + exclus) ne dépasse pas le maximum demandé dans le
   message de lancement, et chaque exclu a une `raison` qui correspond à une exclusion listée.
6. Chaque prospect noté ≥ 60 a au moins une couleur hexadécimale valide (`#RRGGBB`) et un
   `angle` d'une phrase qui s'appuie sur sa preuve la plus forte.
7. Aucun champ inventé : `email_public` vaut `null` ou une adresse citée dans une preuve ou
   visible sur le site ; les champs inconnus valent `null`.
8. `prospects_vus.json` (memory store) contient, en plus de son contenu initial, tous les
   SIREN analysés pendant ce run (prospects et exclus ayant un SIREN).
9. Contre-vérification des preuves : `/mnt/session/outputs/verification_preuves.json`
   contient au moins 3 entrées tirées au hasard. Pour chacune, `trouvee` vaut `true`,
   `url_preuve` et `preuve` sont identiques à celles du critère correspondant dans
   `prospects_{date}.json`, et `extrait_page` contient la citation `preuve` (au mot près
   ou quasi : casse, espaces, ponctuation mis à part). Sinon : échec.
