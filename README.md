# meshes-designer

Éditeur de maillages 2D en **vanilla JavaScript** (aucune dépendance, aucun build). Dessiner des points, constituer des triangles, sauvegarder / charger des scènes au format JSON ou « meshes », pivoter / zoomer / déplacer la vue à la souris.

## Démarrage rapide

Le projet est 100 % statique, mais le module `convert.js` lit des fichiers locaux via `FileReader`, ce qui impose d'ouvrir la page via HTTP (et non en `file://`).

```bash
# Depuis la racine du projet :
python3 test_server.py
# puis ouvrir http://localhost:8000/main.html dans un navigateur
```

Le script `test_server.py` lance un serveur HTTP trivial sur le port 8000 (en thread daemon, avec un délai de 2 s pour permettre Ctrl-C en cas de besoin).

## Workflow type (exemple : un triangle)

1. Lancer le serveur (`python3 test_server.py`) et ouvrir `http://localhost:8000/main.html`.
2. Appuyer sur `G` → la grille s'affiche ; le bouton « Grille » passe en vert et affiche le pas courant.
3. Cliquer trois fois sur le canvas → les clics remplissent successivement les slots `p1`, puis `p2`, puis `p3` du **dernier triangle partiel**. Le premier clic insère donc un triangle `{p1}`, le deuxième lui ajoute `p2`, et le troisième complète `{p1, p2, p3}` (premier triangle complet). Au-delà du troisième clic, un nouveau clic suffisamment proche d'une ligne existante crée un triangle attaché à cette ligne (`{p1, p2, p3}` directement complet, dont deux sommets sont les extrémités de la ligne).
4. *(optionnel)* Sélectionner plusieurs points (clic ou rectangle de sélection), puis **molette** pour les faire pivoter autour du centre de la sélection.
5. **Sauvegarder** avec `Ctrl+S` (ou le bouton vert *save*) → la scène descend en JSON.
6. **Recharger** plus tard via le bouton bleu *Charger meshes* (1 ligne = 1 forme) ou *Charger JSON* (round-trip exact), au choix *Remplacer* ou *Fusionner*.
7. Naviguer entre formes via ◀ / ▶, créer une forme vide avec +, supprimer la forme active avec ×.
8. En cas d'erreur : `Ctrl+Z` annule, `Ctrl+⇧+Z` / `Ctrl+Y` rétablissent.

Orienter la vue pendant la construction : **molette** pour zoomer (×1.1 par cran, centré sur le curseur), **clic milieu + drag** pour déplacer le repère (pan), `Ctrl+0` pour revenir à 100 % centré sur l'origine.

## Fonctionnalités

- **Scène multi-formes** : chaque forme possède ses propres points (`pointList`) et triangles (`tris`). Navigation par *forme précédente / suivante / nouvelle / supprimer* depuis la barre d'outils, ou via le compteur `i/N` affiché en pilule verte.
- **Forme active seulement** : les opérations d'édition (sélection, déplacement, suppression) ne concernent que la forme courante ; les autres sont rendues en lignes estompées pour contexte.
- **Grille magnétique** : pas affichable et ajustable à la molette sur le bouton grille ; middle-click sur ce même bouton réinitialise le pas au défaut ; `G` affiche / masque.
- **Navigation** :
  - **wheel** : zoom centré sur le curseur (×1.1 par cran, clamp `[0.1, 10]`) ; pivote les points sélectionnés si 2+ sont sélectionnés.
  - **middle-click + drag** : déplace l'origine (pan du `viewCenter`), le contenu suit le curseur (convention « grab content »).
  - **Ctrl+0** : réinitialise le zoom à 100 % et `viewCenter` à l'origine.
- **HUD bas-gauche** : indicateur de zoom (`1.2x pos(45, -30)`) et coordonnées du curseur en temps réel.
- **Persistance** : la scène et le zoom/pan sont sauvegardés dans `localStorage` et restaurés au rechargement.
- **Annuler / Rétablir** : `Ctrl+Z` / `Ctrl+⇧+Z` / `Ctrl+Y`.
- **Import / Export** : JSON de scène (round-trip exact) ou format texte « meshes » (1 ligne = 1 forme).

## Raccourcis clavier

| Touche | Action |
|---|---|
| `Backspace` | Supprimer le point sélectionné |
| `⇧+Backspace` | Réinitialiser complètement la scène (modale de confirmation) |
| `Ctrl+Z` | Annuler |
| `Ctrl+⇧+Z` ou `Ctrl+Y` | Rétablir |
| `Ctrl+S` | Sauvegarder la scène en JSON |
| `Ctrl+0` | Réinitialiser le zoom (100 %, recentré sur l'origine) |
| `G` | Afficher / masquer la grille |
| `?` | Afficher / masquer l'aide |
| **Souris** | |
| wheel sur canvas | Zoom (centré sur curseur) ou pivote si 2+ points sélectionnés |
| middle-click + drag canvas | Pan (déplace `viewCenter` dans le sens du drag) |
| middle-click sur bouton grille | Réinitialise le pas de la grille |

## Interface — barre d'outils

Carte flottante en haut à gauche, séparée en 5 sections par des traits verticaux :

![Barre d'outils flottante (capture d'écran)](assets/barre_boutons.png)

Légende (de gauche à droite) :

- **Canevas** (3 boutons gris) — `▦` *Grille* : afficher / masquer la grille (raccourci `G`). Affiche le pas à droite de l'icône ; molette sur ce bouton = ajuster le pas, *clic milieu* sur le bouton = réinitialiser le pas. `↻` *Reset* : réinitialiser complètement la scène (`⇧+Backspace`, modale de confirmation). `▢` *Tout sélectionner* : sélectionne tous les points de la forme active.
- **Sortie** (1 bouton vert, accent vert + silhouette disquette) — `▤ SAVE` : exporte la scène courante en JSON (`Ctrl+S`). La couleur et la silhouette (disquette) sont distinctes des entrées pour éviter l'ambiguïté (les anciennes flèches haut/bas étaient des miroirs faciles à inverser).
- **Entrées** (2 boutons bleus) — `▤△ MESHES` : importe un fichier texte « meshes » (1 ligne = 1 forme). `▤ JSON` : importe une scène JSON (round-trip exact) ; un drop direct d'un fichier `.json` sur le canvas déclenche aussi l'import.
- **Navigation entre formes** (4 boutons gris + compteur) — `◀` *forme précédente*, `▶` *forme suivante*, `(i/N)` *compteur actif / total* en pilule verte (read-only), `+` *ajouter une forme vide*, `×` *supprimer la forme active*.
- **Aide** (1 bouton gris) — `?` ouvre le modal des raccourcis (touche `?` au clavier également).

Les icônes de cette barre sont des **SVG inline** `stroke="currentColor"` 14 × 14 px dans le DOM (pas des images) ; la capture ci-dessus (`assets/barre_boutons.png`) les montre tels qu'ils apparaissent à l'écran. Les libellés textuels sont volontairement cachés pour gagner de la place (l'icône seule suffit car chaque bouton est détaillé dans la légende ci-dessous) : le verbe reste accessible dans le `title=` (tooltip au survol) et dans la modale d'action.

## Format de fichier

### Format « meshes » (texte, 1 ligne = 1 forme)

```
x1,y1;x2,y2;x3,y3;x4,y4;...
```

Chaque triplet consécutif de coordonnées forme un triangle. Un reliquat de 1 ou 2 points en queue de ligne produit un triangle partiel. Toutes les coordonnées sont des flottants, séparées par `,`, les sommets par `;`. Une structure `x1,y1;x2,y2` (2 points) génère un triangle `{p1, p2}` ; 3 points → `{p1, p2, p3}` ; etc. Les coordonnées identiques (même `x,y`) sont dédupliquées dans `pointList`.

`assets/alphabet2` est un exemple historique au format meshes.

### Format JSON (round-trip de la scène interne)

```json
{
  "shapes": [
    {
      "pointList": [
        { "x": 0, "y": 0 },
        { "x": 10, "y": 0 },
        { "x": 5, "y": 8.66 }
      ],
      "tris": [
        { "p1": 0, "p2": 1, "p3": 2 }
      ]
    }
  ],
  "activeShapeIndex": 0,
  "GRID_STEP": 5,
  "GRID_VISIBLE": true,
  "zoomLevel": 1,
  "viewCenter": { "x": 0, "y": 0 }
}
```

Les index `p1, p2, p3` sont des positions dans `pointList`.

## Mode d'import

Cliquer sur le bouton bleu **« Charger meshes »** (icône page + triangle) ou **« Charger JSON »** (icône dossier) ouvre un picker. Une modale propose ensuite deux modes :

- **Remplacer** la scène courante (défaut).
- **Fusionner** : ajoute les formes importées aux formes existantes (utile pour assembler des pièces).

Un drop direct d'un fichier JSON sur le canvas déclenche aussi l'import.

## Organisation du code

| Fichier | Rôle |
|---|---|
| `main.html` | Layout, CSS (toolbar, HUD, modales), déclaration des boutons et du modal d'aide, monte les scripts. |
| `main.js` | Logique applicative : état (`ctx`, `shapes`, sélection, zoom, `viewCenter`), événements souris / clavier, dessin, undo, persistance, import / export. |
| `draw.js` | Primitives de rendu (points, lignes, triangles, axes, grille). Toutes les coordonnées passent par `modelToScreen()` pour tenir compte du zoom et du `viewCenter`. |
| `convert.js` | Parseur du format « meshes » → JSON multi-formes + import par fichier + auto-import via `?autoimport=<base64-urlsafe>` (pratique pour tests headless). |

### Conventions

- **Y inversé** : `modelToScreen.y` inverse l'axe Y (un `model.y` plus grand s'affiche plus haut sur le canvas, comme dans un repère mathématique). Garder cette convention à l'esprit quand on touche au panning.
- **`ctx`** : `{ center: { x: 50, y: 50 }, viewCenter: { x: 0, y: 0 }, zoomLevel: 1 }`. `center` est la position en pixels du centre du repère modèle sur le canvas ; `viewCenter` est le point du modèle présentement centré ; `zoomLevel` est un multiplicateur.
- **Pas de framework** : pas de bundler, pas de transpileur. Le serveur de dev est juste un `http.server` Python.

## Astuces de développement

- Lancer le serveur en arrière-plan et recharger la page suffit pour itérer sur `main.js` / `draw.js` / `convert.js` (pas de HMR).
- Pour tester un import meshes sans picker (headless / script) :
  `http://localhost:8000/main.html?autoimport=<texte-base64-URL-safe>`
- Vérifier la syntaxe après modifications :
  `node --check main.js && node --check draw.js && node --check convert.js`
- La persistance `localStorage` survit au rechargement — utile de l'effacer depuis les devtools entre deux tests (`Clear storage`).

## Licence

Pas de licence déclarée.
