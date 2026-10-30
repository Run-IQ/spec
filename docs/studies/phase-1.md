# Étude de l'existant — Phase 1

Date : 2026-10-30. Lecture seule : aucun dépôt modifié. TaxeFacile lu pour les formes seulement, sans reprise de données. Les comportements marqués *(exécuté)* ont été reproduits avec `core/dist` dans un script hors dépôt ; le reste est lu dans le code.

## 1. Inventaire des formes d'une règle

| Forme | Fichier | Rôle | Champs |
|---|---|---|---|
| `Rule` | `core/src/types/rule.ts` | règle exécutable | `id, version, model, params: unknown, condition?: {dsl, value}, priority, effectiveFrom: Date, effectiveUntil: Date \| null, tags: readonly string[], checksum, schemaVersion?, dominanceGroup?` |
| `RuleInput` | `context-engine/src/stores/RuleStore.ts` | écriture au store | `id?, model, tenantId, country?, region?, scope, effectiveFrom: string, effectiveUntil?, priority?, tags?, description?, source?, payload: string, createdBy, metadata?` |
| `SerializedRule` | idem | lecture du store | `RuleInput` + `version, status, checksum, createdAt, updatedAt, publishedAt/By?, deprecatedAt/By?` (`effectiveUntil` et `tags` toujours présents) |
| `RuleMetadata` | idem | listing | sous-ensemble de `SerializedRule`, sans `payload`, `checksum`, `region` |
| `FiscalRule` | `plugin-fiscal/src/types/fiscal-rule.ts` | `Rule` + champs fiscaux | `jurisdiction: NATIONAL\|REGIONAL\|MUNICIPAL`, `scope: GLOBAL\|ORGANIZATION\|USER`, `country`, `category`, `params` typés |
| payload `policy-bridge` | `policy-bridge/src/generators/RuleInputGenerator.ts` | `RuleInput` généré | payload `{id: node.id, model, params, condition?}` ; `RuleInput` **sans `id`** ; `tags: [domain, sourceRef, 'policy-bridge-generated']`, `source: policy-graph:<g>:<n>`, `metadata` (confiance, versions) |
| `toRule` | `decision-graph/src/resolver/RuleStoreResolver.ts` | store → `Rule` | lit `params`, `condition` du payload, le reste des colonnes ; reprend `sr.checksum` ; perd `dominanceGroup` et tout champ d'extension |
| `create_rule` | `mcp-server/src/tools/create-rule.ts` | génération par LLM | `id, version: 1, model, params, priority ?? 1000, effectiveFrom/Until` (chaînes), `tags ?? []`, `condition?`, champs `ruleExtensions` des plugins ; checksum `computeRuleChecksum` sur dates **chaînes** |
| `withChecksum` | `web-platform/src/lib/examples.ts` | exemples du playground | copie locale de `canonicalStringify` + `computeRuleChecksum` (sans le cas `Date`), dates `'2025-01-01'`, champs fiscaux à plat |
| `validate` | `cli/src/commands/validate.ts` | contrôle de fichier | `hydrateRule` puis présence de `id, version, model, params, priority, effectiveFrom, tags, checksum` ; **ne vérifie pas** la valeur du checksum malgré sa description |
| schéma `evaluate` | `server/src/schemas/evaluate.ts` | API HTTP | mêmes requis que le CLI, `schemaVersion` déclaré, extensions admises |

## 2. Champs de contenu (entrent dans le checksum)

Légende des formes : C = `Rule` core, S = `RuleInput`/`SerializedRule`, P = payload store, F = `FiscalRule`, B = policy-bridge, D = `toRule`, M = mcp, W = web, T = TaxeFacile.

| Champ | Formes | Verdict | Raison |
|---|---|---|---|
| `id` | C S P B D M W T | garder | identité. Le store peut le générer (`rule-<ts>-<n>`) ; policy-bridge ne le transmet pas (voir É6). |
| `version` | C S D M W T | garder | attribuée par le store au `saveRule` (max+1) ; le payload doit être réécrit avec elle (prévu Task 12). |
| `model` | C S P B D M W T | garder | contrôle `payload.model == input.model` déjà fait par `rule-registry`. |
| `params` | C P B D M W T | garder | voir É3 : beaucoup de payloads de test n'ont pas de clé `params`. Type exécutable à laisser `unknown` (É9). |
| `condition` | C P B D M | garder | perdue par TaxeFacile (pas de colonne), ce qui fausse ses calculs. |
| `priority` | C S D M W T | garder | défauts divergents : store 0, mcp 1000, fiscal calcule depuis la juridiction *seulement si absente* — jamais le cas puisque toutes les entrées la fixent (code mort de fait, phase 3). |
| `effectiveFrom` / `effectiveUntil` | partout | garder, normaliser | formats et sémantiques divergents, voir §4. |
| `tags` | C S D M W T | garder | filtrés par `core` (`input.meta.tags`) et par le store. TaxeFacile y code des paires `country:TG`, `category:…`, `scope:…`, `jurisdiction:…` : c'est le besoin réel de `dimensions`. |
| `dominanceGroup` | C T (et F, calculé) | garder | `plugin-fiscal` l'écrase par `category`, donc par `undefined` quand `category` manque : le groupe posé par TaxeFacile est perdu (rupture n°8, phase 3). Absent de `toRule`. |
| `dimensions` | aucune | ajouter | n'existe nulle part ; `country` (S, F) et les tags `clé:valeur` (T) en tiennent lieu. |
| `output` | aucune (B a `node.action.output`) | ajouter | policy-bridge connaît déjà la sortie (`action.output`) mais ne la transmet qu'au graphe. |
| `exceptions` | aucune (PolicyNode a `exceptions?: string[]`) | ajouter, optionnel | les exceptions fiscales sont aujourd'hui des *règles* méta (`META_INHIBITION`, …), pas un champ. Format arrêté en phase 2. |
| `sourceRef` | B (`node.sourceRef`, dans `tags` et `metadata`) | ajouter | ne pas confondre avec `source` du store (provenance `policy-graph:g:n` ; TaxeFacile y met la référence légale). |
| `schemaVersion` | C, schéma `server`, docs web | retirer du type | déclaré dès `45abf80` (types initiaux), jamais lu. S'il est fourni, il passe comme extension. |
| `checksum` | C S M W T | garder hors contenu | exclu du hachage (déjà le cas dans `core`). |

### Champs d'extension (plugin)

| Champ | Formes | Verdict | Raison |
|---|---|---|---|
| `jurisdiction` | F M W T (payload et tags) | extension au premier niveau | sert à calculer une priorité par défaut (`JurisdictionResolver`), jamais atteinte (voir `priority`). Déclaré par `ruleExtensions` du plugin. |
| `scope` fiscal (`GLOBAL/ORGANIZATION/USER`) | F M W T | extension, **renommage à prévoir** | même nom que `scope` du store (`tenant-specific/shared`), sens différent. TaxeFacile confond les deux (`tenant-specific` ↔ `CABINET`). Renommage en phase 3 (migration de `plugin-fiscal`). |
| `country` | F S M W T | `dimensions.country` | filtre `COUNTRY_MISMATCH` dans le plugin (via `input.meta.context.country`) et dans le store. Phase 1 : voir É7. |
| `category` | F M W T (`categoryId`) | extension, puis `dimensions.category` | regroupe le détail fiscal et alimente `dominanceGroup`. Cible : convention de `dimensions` documentée par `plugin-fiscal` (phase 3). |
| autres clés de payload (`rate`, `minThreshold`, `entityType`… chez T ; `v`, `shared`… dans les tests) | P | extension | conservées et hachées par la normalisation prévue ; rien n'est perdu. |

Les extensions restent **au premier niveau** (signature d'index du brief) plutôt que sous `extensions` : `plugin-fiscal`, `create_rule` et les exemples web les lisent à plat. Les déplacer casserait ces lecteurs sans gain en phase 1. Noms réservés à documenter dans `spec` (les 14 champs de contenu + `checksum`).

## 3. Champs hors contenu (store et cycle de vie)

| Champ | Formes | Verdict | Raison |
|---|---|---|---|
| `tenantId` | S | garder hors checksum | clé d'accès ; TaxeFacile utilise `__global__`. |
| `scope` (store) | S | garder | partage `tenant-specific` / `shared`. |
| `region` | S | garder en phase 1 | sert au partage (`listSharedRules`, `RegionRegistry`, exigé si `shared`) ; passage à `dimensions` en phase 5. |
| `status` | S | garder hors checksum | `draft → review → published → deprecated → archived` (+ `review → draft`), transitions contrôlées. TaxeFacile n'a que 3 états (`review`→`DRAFT`, `archived`→`DEPRECATED`). |
| `createdBy/At`, `updatedAt`, `publishedAt/By`, `deprecatedAt/By` | S | garder hors checksum | audit ; `updatedAt` sert de verrou optimiste (`ensureNotStale`). |
| `description` | S (B : `node.label`) | garder hors checksum | libellé ; ne change pas le calcul. |
| `source` | S B T | garder hors checksum | provenance. |
| `metadata` | S B | garder hors checksum | confiance LLM, versions du PolicyGraph. |

## 4. Dates

| Lieu | Format | Fin de période |
|---|---|---|
| `core` (`RuleFilter`) | `Date` ; `now = meta.effectiveDate ?? new Date()` | active si `now <= effectiveUntil` (instant) |
| `InMemoryRuleStore` | chaînes comparées **lexicalement** à `YYYY-MM-DD` (`today()`), sentinelle `9999-12-31` | **inclusive** (jour entier) ; conforme à `ArchitectureV2.md` (`from <= date <= until`) |
| `rule-registry` `validatePeriod` | **exige** `YYYY-MM-DD` | `until > from` strict |
| TaxeFacile (Prisma) | colonnes `Date`, renvoyées en ISO complet | **exclusive** (`effectiveUntil > date`) |
| policy-bridge | défaut `YYYY-MM-DD` du jour | — |
| mcp / web | chaîne libre / `'2025-01-01'` | — |
| decision-graph | `meta.effectiveDate ?? meta.timestamp` (ISO complet possible) | — |

Constats *(exécuté)* :
- `new Date('2025-12-31')` = minuit UTC : une règle « jusqu'au 31/12 » est donc inactive le 31/12 à 10 h dans `core`, active toute la journée dans le store, inactive dès minuit chez TaxeFacile. Trois sémantiques.
- `new Date('2025-01-01T00:00:00')` (sans fuseau) dépend du fuseau de la machine (`2024-12-31T23:00:00.000Z` à Paris). Une normalisation par `new Date(x)` rendrait le checksum dépendant de la machine.
- `'2025-01-01T00:00:00.000Z' <= '2025-01-01'` est faux : si les colonnes du store passent en ISO complet, une règle cesse d'être résolue le jour de son entrée en vigueur.

## 5. Checksums : inventaire et origine

| Calcul | Où | Entrée | Origine |
|---|---|---|---|
| `computeRuleChecksum(rule: object)` | `core/src/utils/crypto.ts` | tout l'objet sauf `checksum`, via `canonicalStringify` | `638c82c` (03-06) `hashParams(params)` seul → `cdba507` (03-09) `{model, params, condition, priority}` → `c2e9dd0` (03-10) objet entier + `Date` en ISO, « pour détecter une altération des dates, tags, id, version, dominanceGroup ». |
| `canonicalStringify` | `core/src/utils/json.ts`, exporté | clés triées, `undefined` omis (tableau → `null`), `Date` → ISO ; **`NaN`/`Infinity` → `null`** *(exécuté)* | `7140c4c` (03-08). |
| `hashParams` | core, exporté | `sha256(canonicalStringify(x))` | utilisé par l'outil MCP `create_checksum`. Garder. |
| `RuleValidator.checkRule` | core | vérifie avant les hooks de plugin (`07eb3f0`, pour que la substitution ne casse pas la vérification) | garder ; `CHECKSUM_MISMATCH`, mode `throw`/`skip`. |
| `sha256(payload)` | `InMemoryRuleStore.saveRule` | la chaîne brute | `373f2a7` (03-17). Le document d'architecture le voulait : « payload = `JSON.stringify(Rule)` opaque, checksum = `sha256(payload)` ». Jamais aligné sur `core`. **Rupture n°1.** |
| `sha256(existing.payload) === sha256(candidate.payload)` | `InMemoryRuleStore.detectConflicts` | chaînes brutes | conflit critique `duplicate_checksum`. |
| `sr.checksum` repris tel quel | `decision-graph` `toRule` | — | `829a308` (03-18). Conséquence : `CHECKSUM_MISMATCH` systématique. |
| recalcul après substitution | `plugin-fiscal` `FiscalPlugin.beforeEvaluate` | `computeRuleChecksum(enriched)` | `1df7cd5` (03-11) ; sans effet sur la vérification (faite avant), sert au snapshot. |
| `sha256(JSON.stringify(lastEvent))` | `rule-registry` `RuleManager.logAudit`, `AuditLogger.verifyIntegrity` | **événement d'audit**, pas une règle | `262fce8` (03-17), chaîne d'audit. |
| `create_rule`, `validate_rules`, `inspect_rule`, `create_checksum` | mcp-server | objet brut (dates chaînes) | `05b248f`, `9cb1d68` (03-09/10). |
| `withChecksum` | web-platform | copie locale, sans cas `Date` | `5043b85` (03-10). |
| `fingerprint`, graphe compilé | context-engine, decision-graph | requêtes / graphes | hors sujet (pas des règles). |

Écarts *(exécuté)* :
- Une règle scellée avec des dates chaînes (`create_rule`, exemples du playground) puis passée par `hydrateRule` (outil `evaluate` du MCP, `useEngine` du web, CLI) **ne passe pas** la vérification : le hachage voit `'2025-01-01'` puis `'2025-01-01T00:00:00.000Z'`. Les exemples du playground sont donc ignorés aujourd'hui. La normalisation des dates de `spec` corrige ce cas sans toucher ces dépôts.
- Scellée avec `Date`, aller-retour JSON puis `hydrateRule` : identique (cas couvert aujourd'hui).
- `effectiveUntil` absent ≠ `effectiveUntil: null` dans `core` ; `condition: undefined` = absent.

## 6. Usages TaxeFacile (lecture seule, formes)

- **Adaptateur Prisma** (`prisma-rule-store.adapter.ts`) : `checksum = sha256(input.payload)` à l'écriture, mais le payload relu est **reconstruit** depuis les colonnes (`id, model, params`, colonnes de taux héritées, `categoryId, entityType, jurisdiction`) : il ne correspond jamais au checksum stocké et n'a pas de `condition`. `country` par défaut `TG`. Dates en ISO complet ; fin de période exclusive ; `duplicate_checksum` par égalité de checksum de payload brut. Statuts réduits à 3.
- **`RuleMapper`** : construit des `Rule` avec `dominanceGroup = categoryId`, tags `clé:valeur`, puis **recalcule** le checksum. `engine.service.ts` recalcule aussi le checksum au rejeu d'un snapshot (règles transformées par le plugin). Ce sont les contournements que `spec` doit rendre inutiles.
- Utilise `RuleStoreResolver` de `decision-graph` avec cet adaptateur : il bénéficiera de `fromStoredRecord` seulement si son payload devient la définition canonique (hors refonte, phase 10).

## 7. Fonctions et exports : verdicts

| Élément | Verdict | Raison |
|---|---|---|
| `core` `computeRuleChecksum` | adapter : délègue à `spec` | changement de valeur des checksums (dates normalisées, défauts `effectiveUntil: null`, `tags: []`, `dimensions: {}`) ; lève pour `NaN`/`Infinity` et pour une règle sans `effectiveFrom` valide (voir É5). |
| `core` `canonicalStringify` | garder, réexporter `canonicalize` de `spec` sous ce nom ou le déprécier | exporté publiquement ; aucun import hors core trouvé (le web en a une copie). Différence : `NaN` → `null` aujourd'hui, erreur demain. |
| `core` `hashParams` | garder | utilisé par le MCP. |
| `core` `hydrateRule(s)` | adapter (Task 11) | même signature ; ajoute les défauts et valide les dates. |
| `core` `Rule`, `Expression` | adapter avec réserves | voir É9. |
| `context-engine` `sha256` | garder | utilisé par dg (fingerprints, hash de graphe) et rule-registry (audit). |
| `decision-graph` `toRule` | remplacer par `fromStoredRecord` | non exporté ; seul consommateur `RuleStoreResolver` (exporté, utilisé par TaxeFacile). |
| `rule-registry` audit chain | garder (É1) | ce n'est pas un checksum de règle. |
| `rule-registry` `defaultRuleSchemaValidator` (no-op) | adapter | `validateRuleDefinition` de `spec` est un meilleur défaut que « tout passe » (rupture n°14), en attendant les descripteurs (phase 5). |
| `rule-registry` `RuleSandbox` | adapter | renvoie `JSON.parse(payload) as Rule` (dates chaînes, sans checksum) ; `fromStoredRecord` donne une vraie `Rule`. |
| web `withChecksum`, mcp `create_rule`, cli `validate` | hors phase 1, à noter | ils marcheront avec `core` 1.0 ; le web doit importer `spec` au lieu de sa copie (le shim `node:crypto` du web n'offre que `createHash('sha256').update(s).digest('hex')` : `spec` doit s'y limiter). Le CLI devrait vraiment vérifier le checksum. |

## 8. Écarts avec le plan

**É1 — Task 14, `rule-registry` : il n'y a pas de checksum de règle à remplacer.**
Plan : `RuleManager.ts`, `AuditLogger.ts` (`verifyIntegrity`), `ConflictDetector.ts` → `computeRuleChecksum` de `spec`.
Code : les `sha256` de `RuleManager`/`AuditLogger` chaînent les **événements d'audit** ; `ConflictDetector` délègue au store. Remplacer casserait `verifyIntegrity`.
Proposition : ne pas toucher au chaînage, sauf pour passer `JSON.stringify(event)` à `canonicalize(event)` (ordre des clés stable quand un adaptateur SQL relit l'événement). Le travail de la Task 14 côté registre se réduit aux peers, au validateur par défaut et à `RuleSandbox` (§7), plus le test bout en bout prévu.

**É2 — `duplicate_checksum` ne peut plus se déclencher si on compare le checksum de spec.**
Plan (Task 12) : « deux sauvegardes d'une définition identique dont seules les dates diffèrent donnent le même checksum (le conflit `duplicate_checksum` le détecte) ».
Code : le checksum couvre `id`, `version` et les dates ; une seconde sauvegarde prend `version+1` (ou un autre `id`), donc un autre checksum. Les tests existants (`context-engine` edge-cases l.460 : ids et dates différents ; `rule-registry` `conflict-blocking`, `ConflictDetector`) attendent pourtant la détection.
Proposition : `spec` exporte aussi `computeRuleFingerprint` = hash canonique de la définition sans `id`, `version`, `effectiveFrom`, `effectiveUntil` ; `detectConflicts` compare cela, après avoir construit la définition du candidat comme `saveRule`. Le test de la Task 12 compare alors `computeRuleChecksum` de deux entrées (dates écrites différemment, même id/version) et le doublon via l'empreinte.

**É3 — Payloads non conformes acceptés aujourd'hui.**
Plan : `saveRule` parse le payload et le réécrit en forme canonique.
Code : le store accepte n'importe quelle chaîne ; des tests sauvent `'not-json-at-all{{{'` (`rule-registry` `RuleSandbox.test.ts` l.82, qui attend `validation_error` au simulate), `'{}'`, `{model:'TAX'}` sans `params`, ou des paramètres à plat (`{rate, base}`).
Proposition : `saveRule` lève `ContextValidationError` (existe déjà) si le JSON est invalide ou si `validateRuleDefinition` échoue ; `params` reste requis (pas de défaut silencieux, principe 6). Mettre à jour les tests concernés (context-engine et rule-registry) et le test du sandbox. Changement de comportement à valider.

**É4 — Dates : la normalisation doit être plus stricte et le store garder `YYYY-MM-DD`.**
Plan : `new Date(x).toISOString()` pour toute date.
Code : §4. Proposition :
- `normalize` n'accepte que `Date`, `YYYY-MM-DD` (minuit UTC) et une date-heure ISO **avec** `Z` ou décalage ; sinon `INVALID_DATE`. Ajouter ce cas aux tests de la Task 9.
- Task 12 : seules les dates du **payload** passent en ISO complet ; `SerializedRule.effectiveFrom/Until` restent telles que reçues (`YYYY-MM-DD`, exigé par `rule-registry`), sinon la résolution lexicale casse.
- Sémantique de fin : décider maintenant et l'écrire dans `spec` ; recommandation : période semi-ouverte `[from, until)`, celle de TaxeFacile, qui permet « la nouvelle version commence quand l'ancienne finit » (phase 5). L'alignement de `core` (`now >= until`) et du store se fait en phase 2 et 5 ; la phase 1 ne change que le hachage.

**É5 — `core.computeRuleChecksum(rule: object)` devient plus strict.**
Aujourd'hui il hache n'importe quel objet (test `handles rules without optional fields` : `{id, model, params, version}` ; outil MCP `create_checksum` sur entrée LLM). Après délégation, il lève sans `effectiveFrom` valide ou `priority`, et sur `NaN`. Proposition : l'accepter, mettre à jour ce test (Task 11 le permet si validé ici) ; le MCP (peer `^0.2.8`, non touché en phase 1) devra attraper l'erreur en phase 9.

**É6 — policy-bridge perd l'identité du nœud.**
Plan (Task 14) : payload complet avec `id`, `version: 1`… ; Task 12 : `id` et `version` du `RuleInput` priment.
Code : `RuleInput` n'a pas d'`id`, le store en génère un ; `node.id` du payload serait écrasé. De plus `InMemoryRuleStore` indexe `id:version` **sans le tenant** : deux tenants qui compilent la même politique avec `id = node.id` se partageraient l'historique.
Proposition : `RuleInput.id = <graphMeta.id>:<node.id>` (stable, unique par politique), `output = node.action.output` (absent du plan), `sourceRef = node.sourceRef` ; `version` laissée au store. `exceptions` du nœud non transmises avant la phase 2.

**É7 — Rien ne dit où vont `country` et `region` du `RuleInput` en phase 1.**
Proposition : `saveRule` copie `RuleInput.country` dans `dimensions.country` de la définition s'il n'y est pas (il entre ainsi dans le checksum) ; les colonnes et filtres du store restent inchangés jusqu'à la phase 5. `region` reste une donnée de partage, hors définition.

**É8 — Chemin du test decision-graph.**
Le test existant est `decision-graph/tests/unit/resolver/RuleStoreResolver.test.ts`, avec un store simulé, `checksum: 'abc123'`, `scope: 'GLOBAL'`, `status: 'PUBLISHED'` (valeurs hors contrat). Avec `fromStoredRecord`, il doit être réécrit ; le plan crée `tests/resolver/…` à côté. Proposition : modifier le fichier existant.

**É9 — Types : `ExecutableRule` tel qu'écrit ne compile pas comme prévu** *(vérifié avec `tsc --strict`)*.
- `Omit<RuleDefinition, …>` sur un type à signature d'index efface tous les champs nommés : `rule.priority` devient `unknown`. Il faut une interface de base sans signature d'index, et la signature ajoutée à part.
- `params: JsonValue` : une interface comme `FlatRateParams` (sans signature d'index, champs `readonly`) n'est pas assignable à `JsonValue`, donc `FiscalRule extends Rule` casse si `Rule = ExecutableRule`. Idem pour `RuleMapper` de TaxeFacile (`params: unknown`).
- `dimensions` requis dans `ExecutableRule` casse chaque littéral `Rule` existant (tests de core, dg, plugin-fiscal, `makeRule`).
- `tags: string[]` : un `readonly string[]` (core, store) n'y est pas assignable.
Proposition : `RuleDefinition` (JSON, `JsonValue`) pour le stockage et le schéma ; `ExecutableRule` côté `core` avec `params: unknown`, `condition.value: unknown`, `tags: readonly string[]`, `dimensions?` optionnel en entrée (les fonctions de `spec` acceptent `readonly`).

**É10 — Où est vérifié le checksum dans `fromStoredRecord`.**
Plan : `fromStoredRecord` lève si le checksum recalculé diffère. Conséquence : un store dont le payload n'est pas canonique (TaxeFacile, anciens enregistrements) lève au lieu d'ignorer la règle avec une raison. C'est voulu (pas d'échec silencieux), mais `RuleStoreResolver` doit laisser l'erreur remonter au nœud avec l'identifiant de la règle, pas renvoyer une liste vide. À préciser dans la Task 13.

## 9. Changements à valider

1. Le `payload` des stores devient la définition canonique complète (`canonicalize(RuleDefinition)`), checksum = `computeRuleChecksum` de `spec`. Conforme à l'intention d'origine (`payload = Rule`, `ArchitectureV2.md`).
2. `computeRuleChecksum` de `core` délègue à `spec` : **toutes les valeurs de checksum changent** (défauts explicites, dates en ISO complet) ; les règles scellées avec des dates chaînes deviennent valides ; `NaN`/`Infinity` et dates invalides lèvent au lieu d'être hachés comme `null`. Mise à jour du test `handles rules without optional fields`.
3. `RuleStoreResolver.toRule` remplacé par `fromStoredRecord` : `dominanceGroup` et les extensions sont désormais transmis à `core` ; une règle altérée lève au lieu de passer avec un checksum faux.
4. `saveRule` refuse un payload invalide (JSON ou définition) — É3.
5. `duplicate_checksum` compare une empreinte de contenu sans `id`, `version` ni dates — É2.
6. Normalisation des dates stricte (pas de date-heure sans fuseau) ; colonnes du store gardées en `YYYY-MM-DD` — É4.
7. Sémantique de `effectiveUntil` arrêtée dans `spec` (recommandation : exclusive), appliquée en phases 2 et 5 — É4.
8. `country` du `RuleInput` copié dans `dimensions.country` ; `region` inchangé — É7.
9. policy-bridge : `id` = `<politique>:<nœud>`, ajout de `output` et `sourceRef` — É6.
10. `rule-registry` : chaîne d'audit conservée (passage à `canonicalize`), validateur par défaut = `validateRuleDefinition`, `RuleSandbox` via `fromStoredRecord` — É1.
11. Types `RuleDefinition` / `ExecutableRule` séparés comme en É9.
12. `schemaVersion` retiré du type `Rule` (jamais lu ; passe en extension s'il est fourni).
13. Les extensions restent au premier niveau ; `scope` fiscal à renommer en phase 3.

Hors phase 1, à reporter : web-platform importe `spec` au lieu de sa copie ; CLI `validate` vérifie vraiment le checksum ; MCP attrape les erreurs de checksum ; `plugin-fiscal` n'écrase plus `dominanceGroup` et lit `dimensions` (phase 3).
