# skip-auto-validated

Plugin CVAT UI qui fait sauter, dans la navigation "Filtered" (Précédent/Suivant),
les frames déjà marquées comme validées par un process d'auto-validation.

## Ce que ça fait

1. Détecte le chargement d'un nouveau job.
2. Active le mode de navigation "Filtered" (`NavigationType.FILTERED`) pour ce job.
3. Remplace (`patch`) `jobInstance.annotations.search` — la fonction que les
   boutons natifs Précédent/Suivant appellent en mode "Filtered" — par une
   version qui parcourt les frames une à une et retourne la première qui ne
   porte **pas** de Tag annotation avec le label `auto_validated`.

## Pourquoi un patch plutôt que le filtre natif de CVAT ("Filters" panel)

Le moteur de filtre natif de CVAT (JsonLogic) matche une frame dès qu'**au
moins un** objet de la frame satisfait le prédicat (sémantique OR
existentielle, objet par objet). Il ne peut donc pas exprimer "cette frame
n'a pas de tag X" : une frame sans annotation du tout ne matcherait jamais
non plus, et serait donc aussi sautée à tort par la navigation filtrée. C'est
pour ça qu'on ne touche jamais à `changeAnnotationsFilters` / au panneau
"Filters" — le faire cacherait en plus tous les objets non-tag de l'affichage
courant (cette même variable Redux sert aussi à décider ce qui est
affiché/récupéré pour la frame courante, pas seulement à la navigation).

## Configuration

Tout se règle en tête de fichier
(`src/ts/index.tsx`) :

```ts
const AUTO_VALIDATED_TAG_LABEL = 'auto_validated';
```

Le nom du label de tag à considérer comme "déjà validé". À adapter si le
label change de nom dans le projet.

## Limites connues

- Ne fonctionne que pour la navigation en mode "Filtered" (boutons
  Précédent/Suivant). Les modes "Empty"/"Chapter" gardent leur comportement
  natif inchangé.
- Respecte le réglage "afficher les frames supprimées" comme le fait
  l'algorithme natif.
- N'affiche aucun filtre actif dans le panneau "Filters" (volontaire, voir
  ci-dessus) : rien à l'écran n'indique visuellement pourquoi une frame est
  sautée, à part le comportement de navigation lui-même.

## Build & déploiement

Le plugin est chargé uniquement s'il est listé dans la variable d'env
`CLIENT_PLUGINS` au moment du build de `cvat-ui` (mécanisme standard CVAT,
voir aussi `cvat-ui/plugins/sam` pour un autre exemple). Il n'a aucun effet
sur un build qui ne le liste pas.

Depuis la racine du dépôt :

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_ui \
  --build-arg CLIENT_PLUGINS=plugins/skip-auto-validated
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d cvat_ui
```

Pour combiner avec le plugin `label-shortcuts` (les deux tournent ensemble
en usage réel) :

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_ui \
  --build-arg CLIENT_PLUGINS=plugins/skip-auto-validated:plugins/label-shortcuts
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d cvat_ui
```

Ces deux commandes sont nécessaires à **chaque** modification du fichier
`index.tsx` — éditer la source seule ne suffit pas, le conteneur `cvat_ui`
sert un bundle déjà compilé tant qu'il n'est pas reconstruit et redémarré.

Après déploiement, recharger la page CVAT avec un rechargement forcé
(Ctrl+Shift+R) pour être sûr de charger le nouveau bundle.
