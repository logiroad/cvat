# label-shortcuts

Plugin CVAT UI qui assigne un raccourci clavier à chaque label d'un projet,
selon son rang dans l'ordre alphabétique, avec une correspondance
touche/rang entièrement personnalisable et une persistance stable par
projet.

## Ce que ça fait

1. Au chargement d'un job, récupère tous les labels du **projet** (pas
   seulement ceux du job) via `core.projects.get({ id: projectId })`.
2. Ne garde que les labels dont le type est compatible avec un **masque**
   (voir `ELIGIBLE_LABEL_TYPES` ci-dessous) — les labels de type Tag (ou tout
   autre type incompatible) ne consomment jamais un des emplacements de
   raccourci.
3. Trie ces labels alphabétiquement, puis mémorise cet ordre dans le
   `localStorage` du navigateur, par ID de projet — les rangs déjà attribués
   ne bougent plus jamais, même si l'ordre alphabétique change (nouveau
   label ajouté, etc.) : les nouveaux labels sont simplement ajoutés à la
   suite.
4. Applique `SLOT_RANKS` (voir ci-dessous) pour décider quel rang alimente
   quel raccourci clavier.
5. Au clavier, reproduit le comportement natif de CVAT (relabelliser l'objet
   sélectionné si son type est compatible, ou mémoriser le label par défaut
   du prochain objet dessiné sinon).

Ces raccourcis restent actifs en changeant de job dans le même projet (rien
n'est recalculé), et sont retrouvés automatiquement en revenant plus tard sur
un projet déjà visité (relu depuis le `localStorage`).

## Configuration

Tout se règle en tête de fichier (`src/ts/index.tsx`) :

### `SHORTCUTS` — quelle touche physique pour quel emplacement

```ts
const SHORTCUTS: { codes: string[]; alt?: boolean; shift?: boolean; ctrl?: boolean }[] = [
    { codes: ['Digit1', 'Numpad1'] },
    { codes: ['Digit2', 'Numpad2'] },
    // ...
];
```

- L'entrée d'index 0 est le raccourci du 1er label, l'index 1 du 2e, etc.
- Le nombre d'entrées plafonne aussi le nombre de labels qui ont un
  raccourci — ajouter/retirer des lignes pour changer ça.
- `codes` liste les valeurs `KeyboardEvent.code` (touche **physique**,
  indépendante de la disposition clavier AZERTY/QWERTY) qui déclenchent ce
  même rang - actuellement la rangée de chiffres du haut et le pavé
  numérique fonctionnent tous les deux pour le même chiffre.
- `alt`/`shift`/`ctrl` : modificateurs requis (actuellement aucun - touche
  seule).
- Pour trouver le code d'une touche physique précise, dans la console du
  navigateur :
  ```js
  document.addEventListener('keydown', (e) => console.log(e.code), { once: true })
  ```

Historique des combinaisons testées et rejetées (pour ne pas les re-tester) :
voir le commentaire en tête de `index.tsx`. En résumé : `Alt+chiffre` est
intercepté par certains gestionnaires de fenêtres Linux (changement de
bureau virtuel) ; `Ctrl+chiffre` seul est réservé par les navigateurs pour
changer d'onglet ; `Ctrl+Shift+chiffre` entre en conflit avec le raccourci
natif CVAT "Switch label" (`labels-list.tsx`, non modifié par ce plugin) ;
`Ctrl+Alt+Shift+chiffre` fonctionne mais a été jugé trop lourd à taper. Le
choix final (chiffre seul, sans modificateur) n'a aucun conflit connu, mais
signifie qu'une frappe est interceptée dès que le focus n'est pas dans un
champ de texte reconnu (voir `isEditableTarget`).

### `ELIGIBLE_LABEL_TYPES` — quels types de labels peuvent avoir un raccourci

```ts
const ELIGIBLE_LABEL_TYPES = new Set<LabelType>([LabelType.MASK, LabelType.ANY]);
```

Seuls les labels dont le type est dans cet ensemble sont candidats à un
raccourci (les autres, ex. les Tags, sont ignorés dès le calcul de l'ordre
alphabétique). À adapter si les raccourcis doivent cibler un autre type de
forme (polygone, rectangle...).

### `SLOT_RANKS` — quel rang alphabétique va dans quel raccourci

```ts
const SLOT_RANKS: number[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13];
```

- 1-indexé. `SLOT_RANKS[0]` = quel rang alimente le 1er raccourci de
  `SHORTCUTS`, etc. Doit avoir exactement `SHORTCUTS.length` entrées.
- Par défaut, séquentiel (`[1, 2, ..., 10]`), mais les rangs peuvent être
  sautés ou répétés librement : ex. `[1, 2, 3, 4, 5, 6, 11, 12, 13, 14]` fait
  cibler les rangs 11 à 14 par les 4 derniers raccourcis, en sautant les
  rangs 7 à 9 (qui n'ont alors aucun raccourci).
- Si un rang demandé n'existe pas (projet avec moins de labels éligibles que
  prévu), un avertissement est affiché en console et ce raccourci reste
  inactif.

## Vérifier le résultat

Après chargement d'un job, la console navigateur affiche un résumé du
mapping actuel :

```
[label-shortcuts] Project 1:  1 -> "Crack", 2 -> "Bleeding", ...
```

## Limites connues

- Utilise un simple listener `keydown` global (`window.addEventListener`),
  pas le système `registerComponentShortcuts`/Mousetrap de CVAT — ces
  raccourcis n'apparaissent donc **pas** dans la fenêtre d'aide Settings →
  Shortcuts.
- Aucune modification du cœur CVAT n'est nécessaire ni faite : le raccourci
  natif "Switch label" (`Ctrl+N`/`Ctrl+Shift+N`, ordre de création) reste
  actif tel quel. Si `SHORTCUTS` est un jour reconfiguré pour réutiliser ces
  mêmes séquences, un conflit réapparaît (comportement imprévisible, lequel
  des deux gagne dépend de l'ordre d'enregistrement Mousetrap) - c'est pour
  ça que la config actuelle évite volontairement Ctrl et Ctrl+Shift.
- Avec le schéma "touche seule" actuel, une frappe est interceptée par ce
  plugin dès que le focus n'est pas reconnu comme un champ de texte
  (`<input>`/`<textarea>`/`contentEditable` - voir `isEditableTarget`), ce
  qui ne couvre pas forcément tous les widgets custom.

## Build & déploiement

Le plugin est chargé uniquement s'il est listé dans la variable d'env
`CLIENT_PLUGINS` au moment du build de `cvat-ui`. Il n'a aucun effet sur un
build qui ne le liste pas.

Depuis la racine du dépôt :

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_ui \
  --build-arg CLIENT_PLUGINS=plugins/label-shortcuts
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d cvat_ui
```

Pour combiner avec le plugin `skip-auto-validated` (les deux tournent
ensemble en usage réel) :

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_ui \
  --build-arg CLIENT_PLUGINS=plugins/skip-auto-validated:plugins/label-shortcuts
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d cvat_ui
```

Ces deux commandes sont nécessaires à **chaque** modification du fichier
`index.tsx` (y compris juste changer `SLOT_RANKS` ou `SHORTCUTS`) — éditer
la source seule ne suffit pas, le conteneur `cvat_ui` sert un bundle déjà
compilé tant qu'il n'est pas reconstruit et redémarré.

Après déploiement, recharger la page CVAT avec un rechargement forcé
(Ctrl+Shift+R) pour être sûr de charger le nouveau bundle.
