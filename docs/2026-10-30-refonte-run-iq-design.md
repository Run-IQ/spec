# Run-IQ : proposition de refonte

*30 octobre 2026. Statut : validé.*

Ce document propose une refonte complète de l'écosystème Run-IQ. Il part de ce que le code fait réellement aujourd'hui (vérifié dépôt par dépôt, exemples exécutés, intégration TaxeFacile analysée), de la vision discutée, et définit un ordre de chantiers avec, pour chacun, un critère de fin vérifiable.

---

## 1. Ce qu'est Run-IQ

**Run-IQ transforme des textes normatifs en logique exécutable, vérifiable et traçable, quel que soit le domaine.**

Un texte (code des impôts, AI Act, règlement environnemental, politique interne) devient un ensemble de règles stockées dans la base de l'organisation qui l'utilise. On pose ensuite des questions à ces règles et on obtient une réponse (un montant, une qualification, une liste d'obligations), la trace complète de son calcul et le passage du texte qui la justifie.

Les utilisateurs visés :

- **Des applications métier** qui intègrent Run-IQ comme bibliothèque, comme TaxeFacile.
- **Des équipes conformité et des régulateurs** (AI Act, Cyber Resilience Act, environnement) qui ont besoin de qualifications et d'obligations traçables.
- **Des chercheurs** qui veulent des encodages reproductibles, des formats ouverts et des mesures de qualité.
- **Des entreprises** qui veulent une application complète déployée chez elles.

### Pourquoi Run-IQ plutôt qu'un format Rules as Code existant

Catala, OpenFisca et DMN sont des façons d'*écrire* des règles. Aucun ne couvre toute la chaîne : partir du texte avec l'aide de l'IA, faire valider par un expert, versionner dans le temps, exécuter en production, prouver un calcul passé. Run-IQ couvre cette chaîne, et accepte ces formats comme sources d'entrée au lieu de les concurrencer.

---

## 2. Principes

Ces principes tranchent les cas où deux choix techniques semblent équivalents.

1. **Agnostique.** `core`, `decision-graph`, les stores et la couche IA ne contiennent aucune notion de domaine. Le test : encoder le code des impôts togolais et l'AI Act sans modifier une ligne de ces packages.
2. **Le plugin est le moule, le texte est la matière.** Un plugin définit des types de règles et leur comportement (taux, barème, qualification, obligation). Les chiffres et les conditions viennent du texte et vivent dans la base de l'utilisateur. `plugin-fiscal` ne connaît pas 18 % ; c'est la règle de TaxeFacile qui le dit.
3. **Le complexe se compose.** Un cas simple est un ensemble de règles évaluées par `core`. Un cas complexe est un graphe de décision dont les nœuds appellent `core` ou d'autres graphes.
4. **On ajoute, on n'écrase pas.** Une mise à jour crée une nouvelle version datée. Un calcul passé reste rejouable avec les règles de son époque.
5. **Tout calcul est prouvable.** Chaque résultat sauvegardé contient une copie des règles utilisées et leur empreinte.
6. **Jamais d'échec silencieux.** Une règle ignorée dit pourquoi, avec le détail. Aucun composant ne renvoie un 0 de remplacement.
7. **L'IA propose, l'humain valide.** Le score de confiance d'un LLM n'est qu'un indice. La qualité se mesure sur des cas de test.
8. **Les briques d'abord, l'application ensuite.** Chaque package doit fonctionner seul et avec les autres avant d'être assemblé dans l'application finale.
9. **Comprendre avant de changer.** Aucune fonctionnalité existante n'est supprimée ou remplacée sans avoir compris pourquoi elle existe. Les décisions de ce document sur chaque brique sont des intentions ; l'étude détaillée de la brique peut les corriger.

---

## 3. État des lieux

Tout ce qui suit a été vérifié dans le code ou reproduit par exécution, sauf mention contraire.

### Ce qui est solide

- **`core`** : pipeline clair, calcul décimal exact, trace, snapshots, conditions par DSL interchangeable.
- **`decision-graph`** : le package le plus abouti (environ 4 000 lignes, 7 000 lignes de tests). Exécution par niveaux ou au plus tôt, parallélisme borné, conditions sur les arêtes, merge, enrich HTTP, sous-graphes.
- **`policy-bridge`** : compilation déterministe d'un PolicyGraph en règles et en graphe. Le graphe généré passe le compilateur de `decision-graph`.
- **`policy-engine`** : la chaîne texte → graphe fonctionne de bout en bout avec un LLM factice.
- **Le découpage en packages** est cohérent avec la vision.

### Ce qui casse quand on assemble les packages

Par ordre de gravité :

1. **Le checksum n'a pas de définition commune.** Les stores calculent `sha256(payload)`, `core` vérifie `computeRuleChecksum(règle)`. Toute règle passée par un store est ignorée par `core` avec `CHECKSUM_MISMATCH`. Conséquence vérifiée : chaque nœud de calcul d'un graphe renvoie 0. TaxeFacile contourne en recalculant le checksum juste avant l'évaluation, ce qui annule la vérification d'intégrité.
2. **Un graphe compilé ne se sauvegarde pas.** Il contient des `Map` JavaScript que `JSON.stringify` perd. Après un aller-retour en base, l'exécution plante (`compiled.failures.get is not a function`).
3. **Le format d'une règle stockée n'existe nulle part.** Chaque package suppose une forme différente du `payload` : `decision-graph` attend `{params, condition}`, `policy-bridge` produit `{id, model, params, condition}`, TaxeFacile écrit ses propres champs et perd la condition.
4. **La dominance ne domine pas.** Deux règles du même groupe avec des priorités différentes s'appliquent toutes les deux (`core/src/engine/DominanceResolver.ts` groupe par priorité *et* groupe). Seule l'égalité de priorité est traitée.
5. **Un snapshot ne se rejoue pas.** Il contient les règles transformées par les plugins, dont les checksums ne correspondent plus.
6. **Un `requestId` déjà vu renvoie un faux résultat** : `value: 0`, sans erreur (`PPEEngine.buildCachedResult`). Dans un graphe relancé, tous les nœuds renvoient 0.
7. **Les raisons d'exclusion n'ont pas de détail.** `SkippedRule` ne contient qu'un code. Les erreurs de validation des paramètres sont jetées. Les erreurs des hooks de plugin sont avalées.
8. **`plugin-fiscal` désactive sans le dire la dominance et le filtre par pays** pour toute règle qui n'a pas ses champs propres (`country`, `category`), c'est-à-dire toutes les règles venant d'un store ou de `policy-bridge`. Il fait aussi passer son état interne par `input.data.__fiscal_*`.
9. **Le graphe généré par `policy-bridge` produit des valeurs nulles** *(lu dans le code, pas exécuté)* : ses nœuds déclarent des ports de sortie nommés d'après l'action (`tva_due`…) que `CoreNodeExecutor` va chercher dans `result.meta`, où ils n'existent pas. La politique de repli renvoie alors `null`. De plus, tous les nœuds sont reliés à un merge final au lieu d'être chaînés selon leurs dépendances.
10. **Les nœuds `branch` et `guard` se comportent comme `compute`.** L'aiguillage ne se fait que par les conditions d'arêtes.
11. **Les sous-graphes ne sont pas versionnés** (appel par identifiant seul) et **les cycles entre graphes ne sont pas détectés** (A appelle B qui appelle A).
12. **`policy-bridge` génère des opérateurs `date_before` / `date_after`** que `dsl-jsonlogic` ne connaît pas.
13. **Trois points d'accès ne chargent pas les plugins de la même façon.** `server` (Docker, `PLUGINS=fiscal`) et `mcp-server` (`--plugin @run-iq/plugin-fiscal`) échouent avec `plugin-fiscal` 0.4.0. Le CLI exige un fichier de réexport.
14. **Les modèles sont décrits plusieurs fois, à la main.** TaxeFacile a recopié la liste des modèles pour `policy-bridge`, avec des erreurs (`THRESHOLD` au lieu de `THRESHOLD_BASED`, `children` au lieu de `steps`). Le validateur de `rule-registry` ne fait rien par défaut.
15. **Le graphe généré par `policy-bridge` ne peut pas recevoir les données métier** *(trouvé par les scénarios de la phase 0)* : chaque nœud exige un port d'entrée nommé `input` qu'aucune donnée ne remplit, et sa politique d'erreur `fallback` masque l'échec (exécution « réussie » avec une sortie nulle).
16. **Les outils de graphe du serveur MCP ne résolvent aucune règle** *(trouvé en fusionnant la branche en phase 0)* : leur résolveur est vide, donc chaque nœud de calcul rend 0, et aucun exécuteur de sous-graphe n'est branché, donc tout nœud `subgraph` échoue. À brancher sur le service de graphes (phase 4) et le stockage (phase 5), en phase 9.

### Ce qui limite l'ambition « tous domaines »

- **Un modèle ne rend qu'un nombre, et `core` additionne tout.** Une qualification, un oui/non ou une liste d'obligations ne s'expriment pas.
- **Les exceptions ne sont pas génériques.** Inhibition, substitution et court-circuit existent, mais seulement dans `plugin-fiscal`.
- **`country` et `region` sont codés en dur** dans les contrats de stockage et dans `rule-registry`.
- **`policy-engine` traduit chaque passage isolément.** Il ne voit ni les définitions du texte ni les articles auxquels un passage renvoie. C'est insuffisant pour un texte comme l'AI Act. Son découpage et sa détection de variables supposent des textes en français.
- **Aucune mesure de qualité de l'IA.** Les tests remplacent le LLM par un faux. Le score de confiance est celui que le LLM se donne.
- **Aucun import de format Rules as Code.**

### Publication et outillage

- Packages publiés sur GitHub Packages, mais des versions plus anciennes traînent sur npm public et certains lockfiles mélangent les deux. Le déploiement du site est probablement cassé pour cette raison.
- `mcp-server` 0.3.0 a été publié depuis une branche non fusionnée, avec des dépendances `file:../`.
- Quatre licences différentes ; `web-platform` et les quatre dépôts `policy-*` n'ont pas de fichier LICENSE.
- **Aucun test n'exécute plusieurs packages ensemble**, ni dans Run-IQ ni dans TaxeFacile (tout y est mocké). C'est la cause première de tous les points précédents.

---

## 4. Architecture cible

### Les notions

| Notion | Définition |
|---|---|
| **Source** | Un texte normatif (ou un encodage existant : DMN, Catala, OpenFisca), découpé en passages identifiables. |
| **Moule** (modèle) | Un type de règle fourni par un plugin : ses paramètres (décrits en JSON Schema), son type de sortie et sa façon de combiner plusieurs résultats. |
| **Plugin** | Un paquet qui fournit des moules, et optionnellement des hooks, des opérateurs de condition et une description pour l'IA et l'interface. Il ne contient aucune règle. |
| **Règle** | Une instance de moule : paramètres, condition, priorité, période de validité, dimensions de portée, sortie produite, référence au passage source. |
| **Graphe** | Une composition de nœuds (calcul via `core`, sous-graphe, enrichissement, fusion) reliés par des arêtes éventuellement conditionnelles. |
| **Décision** | Le résultat d'une évaluation : des sorties typées, la trace, les règles appliquées et ignorées avec leurs raisons, les faits manquants. |
| **Preuve** | Ce qu'on sauvegarde d'une décision : les entrées, les règles exactes et leurs empreintes, les versions des moteurs et plugins. Suffit pour rejouer. |

### Les dépôts

Les dépôts restent séparés (décision prise). Un nouveau dépôt porte le contrat commun.

| Dépôt | Rôle |
|---|---|
| **`spec`** *(nouveau)* | Le contrat : types TypeScript et JSON Schema de règle, règle stockée, décision, preuve, graphe sérialisé, bundle de plugin, descripteur de moule, référence source. La fonction de checksum canonique et le convertisseur règle stockée ↔ règle exécutable. Aucune dépendance d'exécution. Utilisable depuis d'autres langages via les schémas. |
| `core` | Évalue un ensemble de règles et produit une décision. |
| `decision-graph` | Orchestre des nœuds, dont les appels à `core` et à d'autres graphes. |
| `context-engine` | Les interfaces de stockage, les adaptateurs en mémoire et une suite de tests de conformité pour tout adaptateur. |
| `rule-registry` | Le cycle de vie : brouillon, relecture, publication, dépréciation, versions, audit, conflits. |
| `plugin-sdk` | Construire, décrire, tester et **charger** un plugin. |
| `plugin-fiscal` | Les moules fiscaux. |
| `plugin-compliance` *(nouveau)* | Les moules de qualification, d'obligation et d'éligibilité. |
| `dsl-jsonlogic` | Les conditions en JSONLogic. |
| `policy-dsl`, `policy-engine`, `policy-graph`, `policy-bridge` | L'atelier : texte → graphe de politique relu par un humain → règles et graphe exécutables. |
| `cli`, `mcp-server` | Les accès développeur et LLM. |
| `server` | L'application complète, en fin de parcours. |
| `web-platform` | Le site public, la documentation et le playground. |
| **`integration-tests`** *(nouveau)* | Les scénarios de bout en bout qui font tourner plusieurs packages ensemble. |

---

## 5. Décisions de conception par brique

### `spec`

- **La règle a une seule définition.** Son contenu identifiant : `id`, `version`, `model`, `params`, `condition`, `priority`, `effectiveFrom`, `effectiveUntil`, `output`, `dimensions`, `tags`, `dominanceGroup`, `exceptions`, `sourceRef`.
- **Le checksum est calculé sur ce contenu**, sérialisé de façon canonique (clés triées, dates en ISO 8601 complet). Une seule fonction, utilisée partout. Ce qui n'est pas du contenu (statut, auteur, dates de création) n'y entre pas.
- **Un seul convertisseur** règle stockée ↔ règle exécutable. Il remplace `toRule` de `decision-graph`, le `RuleMapper` et le `buildPayload` de TaxeFacile.
- **`dimensions` est un dictionnaire libre** (`{ country: "TG", category: "TVA", role: "provider" }`). Il remplace `country` et `region` des contrats actuels. Les filtres de portée deviennent génériques. Le nom `dimensions` évite la confusion avec le champ `scope` existant de `context-engine` (`tenant-specific` / `shared`), qui garde son sens.
- **Le descripteur de moule** (nom, version, JSON Schema des paramètres, type de sortie, stratégie de combinaison, description) est la source unique pour la validation, `policy-bridge`, le MCP et les formulaires de l'interface.

### `core`

- **Sorties typées.** Chaque règle déclare la sortie qu'elle produit (`output`, par exemple `tva`, `riskLevel`, `obligations`). Le moule déclare le type (nombre, booléen, énumération, liste, objet) et la stratégie de combinaison (somme, max, min, priorité la plus haute, union). La décision contient un résultat par sortie. La somme reste le comportement par défaut des moules numériques.
- **Dominance corrigée** : dans un même groupe, seule la priorité la plus haute s'applique, les autres sont ignorées avec la raison `DOMINATED`. L'égalité reste un conflit.
- **Exceptions natives**, remontées de `plugin-fiscal` : une règle peut en inhiber d'autres, en substituer les paramètres ou court-circuiter une sortie. Le mécanisme ne connaît plus la fiscalité.
- **Diagnostics complets** : chaque règle ignorée porte sa raison et son détail (erreurs de paramètres, message du DSL). Les erreurs des hooks apparaissent dans la décision au lieu d'être avalées.
- **Preuve et rejeu** : la preuve contient les règles source (avant plugins), les entrées et les versions du moteur et des plugins. `engine.replay(preuve)` refait le calcul avec le moteur courant, compare au résultat enregistré et signale tout écart, y compris un écart de version. On ne charge pas d'anciennes versions du moteur côte à côte. Le rejeu commence avec la nouvelle version majeure : les résultats antérieurs à la refonte ne sont pas migrés, puisque TaxeFacile n'est pas en production. *(Mon choix.)*
- **Idempotence honnête** : un `requestId` déjà vu renvoie la décision sauvegardée, ou lève une erreur explicite. Plus jamais de 0 de remplacement.
- **Les plugins ont un espace d'état dédié** dans le contexte d'évaluation, au lieu d'écrire dans `input.data`.
- **Pas de dépendances entre règles à l'intérieur de `core`.** Une évaluation reçoit des faits et produit des sorties. L'enchaînement (une règle qui lit la sortie d'une autre) est le travail du graphe : les sorties d'un nœud deviennent les faits du suivant. `policy-bridge` place donc deux règles dépendantes dans deux nœuds différents. *(Mon choix, conforme au principe 3.)*
- Correction mineure : le minuteur du timeout global est libéré.

### `decision-graph`

- **Sérialisation** d'un graphe compilé, selon le format de `spec`, avec un test d'aller-retour.
- **Ports nommés** : un nœud de calcul expose directement les sorties typées de `core` (`tva`, `riskLevel`…). Cela corrige les valeurs nulles du graphe généré par `policy-bridge`.
- **Aiguillage par les arêtes uniquement** : les types `branch` et `guard` disparaissent, puisque les conditions d'arêtes font déjà ce travail. *(Mon choix ; alternative : les implémenter réellement.)*
- **Liaison explicite nœud → règles** : un nœud déclare quelles règles il évalue (par sortie, par tags, par identifiants), au lieu de la combinaison implicite modèle + `nodeId` qu'aucun store ne sait servir.
- **Sous-graphes versionnés** (identifiant + version, ou empreinte), **détection des cycles entre graphes** à l'enregistrement, profondeur d'imbrication maximale.
- **Identifiants de requête par exécution**, pour qu'une relance ne tombe pas sur l'idempotence de `core`.
- **`NodePolicy.timeout` appliqué**, politique par défaut au lieu d'un plantage si elle manque.
- **Un service de graphes** (charger par identifiant, compiler, mettre en cache, exécuter, historiser), qui remplace le `GraphService` écrit par TaxeFacile.
- **Les entrées d'une exécution sont enregistrées**, pour pouvoir la rejouer.

### `context-engine` et `rule-registry`

- Les contrats utilisent les types de `spec`.
- **Versions sans écrasement** : publier une nouvelle version d'une règle ferme la période de l'ancienne. La version publiée reste immuable.
- **Suite de conformité exportée** : tout adaptateur (Prisma, SQL, autre) l'exécute et sait s'il respecte le contrat. Les adaptateurs de l'application (Postgres) devront la passer.
- **Le validateur de `rule-registry` est construit à partir des descripteurs de moules** des plugins chargés. Plus de liste recopiée à la main.
- **La simulation (`sandbox`) évalue réellement** avec `core` au lieu de seulement valider.
- Les régions et pays sortent du registre générique ; s'ils restent utiles, ils deviennent une convention de `dimensions` documentée par `plugin-fiscal`.

### Plugins

- **Un seul format de bundle et un seul chargeur** dans `plugin-sdk`, qui gère ESM et CommonJS, un chemin de fichier ou un nom de paquet. `cli`, `server` et `mcp-server` l'utilisent tous.
- **`plugin-fiscal`** : utilise `dimensions` au lieu de champs propres, abandonne ses méta-règles au profit des exceptions de `core`, n'écrit plus dans `input.data`, corrige sa description (le national n'écrase pas le régional dans le code actuel). Ses moules restent utilisables pour n'importe quel pays.
- **`plugin-compliance`** *(nouveau)* : moules `QUALIFICATION` (une catégorie, priorité la plus haute), `OBLIGATION` (un élément ajouté à une liste, avec date d'application et référence), `ELIGIBILITY` (oui/non). Il sert à l'AI Act, au CRA ou à NIS2 sans rien contenir de propre à ces textes.
- **`dsl-jsonlogic`** : ajoute les opérateurs de date utilisés par `policy-bridge`.

### Atelier IA (`policy-*`)

- **Ingestion en deux passes.** D'abord le texte entier : structure (articles, annexes), définitions, variables, renvois. Ensuite la traduction passage par passage, en donnant au LLM les définitions et les articles référencés. C'est la condition pour traiter l'AI Act.
- **Indépendant de la langue** : les motifs de structure et de variables deviennent configurables, fournis par défaut pour le français et l'anglais.
- **Adaptateurs LLM fournis** (Anthropic, OpenAI, modèle local compatible OpenAI), injectables comme aujourd'hui.
- **`policy-bridge`** : produit des règles avec leur sortie nommée, chaîne les nœuds du graphe selon les dépendances réelles (une règle qui produit X avant celle qui lit X), exige une date d'effet explicite au lieu d'« aujourd'hui », et lit les descripteurs de moules des plugins.
- **Mesure de la qualité.** Chaque graphe de politique peut porter des cas de test (entrées → décision attendue). Une commande d'évaluation exécute ces cas sur les règles générées et publie un score. Premier jeu de données : le Code général des impôts du Togo, avec des cas attendus construits à partir du texte lui-même. Deuxième : un sous-ensemble de l'AI Act. Le score de confiance du LLM reste affiché mais ne sert plus de garantie.
- **`policy-graph`** : implémenter la fusion, faire respecter la suppression. Moins prioritaire.

### Formats Rules as Code

Import d'abord, export ensuite :

1. **DMN** : les tables de décision se traduisent directement en règles et conditions.
2. **Paramètres OpenFisca** : leurs barèmes et taux datés correspondent aux paramètres des moules.
3. **Catala** : sa logique « par défaut + exceptions » correspond aux exceptions natives de `core`.

L'export vers ces formats sert les chercheurs et évite l'enfermement.

### Accès

- **`cli`** : le chargeur commun, une vraie vérification du checksum, une commande d'évaluation sur cas de test. Plus tard, les commandes de gestion vers le serveur.
- **`mcp-server`** : republié depuis `master` avec le chargeur commun. Il reste un bac à sable, et gagne un mode connecté au serveur pour proposer des règles en brouillon. Pour l'ingestion de documents, il appelle `policy-engine` au lieu de dupliquer cette logique dans son prompt.
- **`server`** (dernière étape) : assemble toutes les briques sans logique propre. API de gestion des règles, des graphes, des exécutions, de l'ingestion et de l'audit ; adaptateur Postgres de référence ; configuration des plugins et des fournisseurs d'IA. Puis l'interface web : accueil, `/manage` pour configurer base de données, sources de données, fournisseurs d'IA et plugins, l'atelier de relecture, l'historique. Livré en image Docker.
- **Accès à l'application : pas de gestion fine des droits** (décision prise). Toute personne authentifiée comme administrateur peut tout faire. On garde quand même deux choses, parce qu'elles servent la preuve et non le contrôle d'accès : le journal d'audit (qui a fait quoi, quand) et le cycle brouillon → publication, même quand la même personne écrit et publie. Dans `rule-registry`, le contrôle des permissions reste une interface : l'application branche « tout autoriser pour l'administrateur », une organisation qui intègre la bibliothèque peut brancher ses propres règles. Pour cela, l'interdiction d'approuver sa propre règle devient une option désactivable.
- **`web-platform`** reste le site public et le playground. *(Mon choix : l'interface de l'application vit dans l'image du serveur, pas dans ce dépôt.)*

---

## 6. Ordre des chantiers

Chaque phase se termine par un critère vérifiable, presque toujours un scénario de `integration-tests` qui passe.

**Chaque phase commence par une étude de l'existant** des dépôts qu'elle touche, avant toute modification :

1. **Inventaire** : chaque fonctionnalité, option et export public, avec les tests qui la couvrent.
2. **Origine** : l'historique git, les messages de commit et les commentaires qui expliquent pourquoi elle existe.
3. **Usages** : qui s'en sert, dans les autres dépôts Run-IQ et dans TaxeFacile (en lecture seule).
4. **Verdict** pour chaque élément : garder, adapter ou retirer, avec la raison.

Le résultat est une note courte par phase. La liste de ce qui est retiré ou dont le comportement change t'est présentée avant d'écrire le code. Si l'étude contredit une décision de ce document, on revient d'abord sur la décision. Exemple : la suppression des nœuds `branch` et `guard` n'est confirmée qu'après avoir vérifié pourquoi ils ont été créés et si quelqu'un compte sur eux.

| # | Phase | Contenu | Fini quand |
|---|---|---|---|
| 0 | **Socle** | Espace de travail local reliant les 15 dépôts ; dépôt `integration-tests` avec les scénarios écrits *en rouge* (ils documentent les bugs actuels) ; nettoyage de la publication ; `mcp-server` republié depuis `master`. | Une commande construit et teste tous les dépôts liés entre eux. Les scénarios échouent pour les raisons listées en section 3. |
| 1 | **Contrat commun** | Dépôt `spec` ; checksum et convertisseur uniques ; adoption par `core`, `context-engine`, `decision-graph`, `rule-registry`, `policy-bridge`. | Règle stockée → graphe → `core` donne le bon montant, sans recalcul de checksum. |
| 2 | **Moteur de décisions** | Sorties typées, combinaison, dominance, exceptions natives, diagnostics, preuve et rejeu, idempotence. | Les tests fiscaux passent inchangés en valeur ; un scénario qualification + obligations passe dans `core` seul ; une preuve se rejoue à l'identique. |
| 3 | **Plugins** | Bundle et chargeur uniques ; descripteurs de moules ; migration de `plugin-fiscal` ; création de `plugin-compliance` ; opérateurs de date. | `cli`, `server` et `mcp-server` chargent n'importe quel plugin de la même façon. |
| 4 | **Orchestration** | Sérialisation, ports nommés, aiguillage par arêtes, liaison nœud → règles, sous-graphes versionnés, cycles, service de graphes. | Un graphe sauvegardé puis rechargé s'exécute ; un calcul de type impôt sur le revenu français passe par des sous-graphes. |
| 5 | **Stockage et cycle de vie** | Versions sans écrasement, `dimensions`, suite de conformité, validateur depuis les plugins, simulation réelle. | La suite de conformité passe sur l'adaptateur en mémoire et sur un adaptateur SQL de test. |
| 6 | **Atelier IA** | Deux passes, langues, adaptateurs LLM, câblage de `policy-bridge`, évaluation. | Texte → décision de bout en bout ; un score mesuré et publié sur le jeu CGI Togo et sur le sous-ensemble AI Act. |
| 7 | **Preuve par l'usage** | Deux démonstrations complètes sur les mêmes versions : le CGI togolais (calculs) et le sous-ensemble AI Act (qualifications et obligations). | Les deux tournent du texte à la décision, sans une ligne de domaine dans `core`, `decision-graph`, les stores ni l'atelier. |
| 8 | **Rules as Code** | Import DMN, paramètres OpenFisca, Catala ; exports. | Un encodage existant importé donne les mêmes résultats que dans son outil d'origine sur un jeu de cas. |
| 9 | **Accès** | `cli` et `mcp-server` mis à niveau. | Parcours brouillon → relecture → publication depuis le MCP. |
| 10 | **Application** | `server`, interface web, `/manage`, image Docker. | Une organisation déploie l'image, configure sa base et ses plugins dans `/manage`, ingère un texte et obtient une décision. |

Les phases 2 et 3 peuvent avancer en parallèle une fois la phase 1 terminée. Les README sont mis à jour à la fin de chaque phase pour les dépôts touchés.

### Publication

Uniquement GitHub Packages (décision prise). Les versions publiées sur npm public sont dépréciées avec un message pointant vers GitHub Packages.

Les nouveaux contrats justifient une version majeure coordonnée de tous les packages, publiée dans l'ordre des dépendances : `spec`, `core`, `context-engine`, `dsl-jsonlogic`, `plugin-sdk`, `decision-graph`, `rule-registry`, plugins, `policy-*`, accès. Pendant la refonte, chaque phase terminée est marquée par un tag git et une release GitHub sur les dépôts touchés, avec des préversions (`x.0.0-next.N`) publiées sur GitHub Packages. La version stable sort à la fin de la phase 7. *(Mon choix ; tu m'as laissé juger des tags et releases.)*

`mcp-server` : la version 0.3.0 installée par TaxeFacile vient de la branche non fusionnée `feat/decision-graph-integration` (outils de graphe, environ 2 000 lignes). Cette branche est relue, fusionnée dans `master`, puis publiée normalement. On ne jette pas ce travail et on ne republie pas `master` tel quel. *(Mon choix.)*

### TaxeFacile

TaxeFacile reste en dehors de la refonte (décision prise). Il a servi d'audit : ses contournements listés en section 3 guident les corrections. Une fois l'application (phase 10) en place, on décidera comment le faire passer sur les nouvelles versions. D'ici là, on ne le modifie pas et on ne réutilise pas ses données ; le CGI togolais sera ingéré directement depuis le texte.

---

## 7. Ce qu'on ne fait pas

**Hors périmètre :**
- Un monorepo (décision prise).
- La publication sur npm public (décision prise).
- Un nouveau langage de règles lisible par les humains pour concurrencer Catala. Le format interne est une structure de données ; les humains travaillent dans l'atelier.
- L'interface web avant que les briques passent leurs critères de fin.
- Le partage de règles entre organisations (« packs ») : utile plus tard, pas maintenant.

**Ce qui ferait échouer la refonte même si tout compile :**
- Une notion de domaine qui entre dans `core`, `decision-graph`, les stores ou l'atelier.
- Une règle ignorée, une valeur nulle ou un 0 sans explication.
- Une mise à jour qui rend un calcul passé impossible à rejouer.
- Des packages qui ne marchent qu'isolément.

---

## 8. Décisions

**Prises par toi :**
- Run-IQ est agnostique ; le fiscal n'est qu'un domaine.
- Le plugin est le moule ; les règles naissent du texte et vivent dans la base de l'utilisateur.
- Le graphe de décision pour les cas complexes, avec des sous-graphes.
- Les dépôts restent séparés, avec un dépôt de contrats partagé.
- Publication sur GitHub Packages uniquement.
- Une application complète à la fin (accueil, `/manage`, image Docker), après que les briques sont solides.
- TaxeFacile reste en dehors de la refonte ; on y reviendra une fois l'application en place.
- Viser la solution la plus robuste possible à chaque brique, même si elle est plus longue à faire.
- Tags et releases laissés à mon jugement.
- Pas de gestion fine des droits dans l'application : l'administrateur peut tout faire.

**Mes choix, à vérifier en lisant :**
- Le contenu exact du dépôt `spec` et le calcul du checksum sur le contenu canonique.
- Les sorties typées avec une stratégie de combinaison déclarée par le moule.
- Les exceptions déplacées de `plugin-fiscal` vers `core`.
- `dimensions` en dictionnaire libre à la place de `country` et `region`.
- La suppression des nœuds `branch` et `guard`.
- Un nouveau `plugin-compliance` plutôt qu'un plugin par texte.
- L'ingestion en deux passes.
- DMN comme premier format importé.
- L'interface de l'application dans l'image du serveur, pas dans `web-platform`.
- Pas de dépendances entre règles dans `core` : l'enchaînement passe par le graphe.
- Le rejeu se fait avec le moteur courant et signale les écarts ; pas de compatibilité avec les résultats d'avant la refonte.
- Des préversions publiées à chaque phase, la version stable à la fin de la phase 7.
- La branche `feat/decision-graph-integration` de `mcp-server` relue et fusionnée, pas abandonnée.

---

## 9. Questions tranchées en fin de conception

Les points 3 et 4 restent ouverts ; le choix indiqué s'applique tant que tu ne dis pas autre chose.

1. **Licences** (décidé : plugins propriétaires, propriété intellectuelle en BSL, le reste libre). Répartition validée :
   - **Propriétaire** (comme `plugin-fiscal` aujourd'hui) : `plugin-fiscal`, `plugin-compliance` et les futurs plugins.
   - **BSL 1.1** : `core`, `decision-graph`, `rule-registry`, `policy-engine`, `policy-bridge`, `server` (l'application).
   - **MIT** : `spec`, `plugin-sdk`, `dsl-jsonlogic`, `policy-dsl`, `policy-graph`, `context-engine`, `cli`, `mcp-server`, `integration-tests`, `web-platform`.
   Les fichiers LICENSE et les champs `license` des `package.json` sont alignés en phase 0.
2. **Graphes qui s'appellent eux-mêmes** (laissé à mon jugement). Les cycles entre graphes sont refusés. Le besoin réel derrière, un calcul qui boucle jusqu'à se stabiliser (par exemple retrouver un salaire brut à partir du net, ou un impôt qui entre dans sa propre base), est couvert par un type de nœud dédié, `iterate`. Il exécute un sous-graphe en boucle, avec un nombre maximal d'itérations et une tolérance de convergence obligatoires, et chaque itération apparaît dans la trace. C'est explicite, borné et traçable, là où une récursion libre ne l'est pas. Le format de `spec` le prévoit dès la phase 1 ; il est implémenté en phase 4.
3. **Validation experte.** *En attendant :* la phase 6 publie un score sans seuil minimum, et c'est toi qui relis les cas attendus du CGI togolais et de l'AI Act (articles 5, 6, annexe III et 50).
4. **Fournisseurs d'IA prioritaires.** *En attendant :* Anthropic d'abord, puis un adaptateur compatible OpenAI, qui couvre aussi les modèles locaux.
