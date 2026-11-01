# Étude de l'existant — Phase 0

> Édition publique : l'application cliente étudiée n'est pas nommée et ses détails internes sont décrits de façon générique.

Date : 2026-10-30. Lecture seule : aucun dépôt modifié. Dossiers locaux : `spec` et `integration-tests` n'existent pas (ni dossier, ni dépôt `Run-IQ/*` sur GitHub) ; ils sont à créer en phase 1.

## 1. Publication

Dépôts GitHub : tous publics sauf `plugin-fiscal` (privé). Les paquets sur GitHub Packages sont tous `private` (visibilité).

| Dossier / paquet              | Local | GitHub Packages      | npm public    | `publishConfig` | `.npmrc`                                    |
| ----------------------------- | ----- | -------------------- | ------------- | --------------- | ------------------------------------------- |
| core                          | 0.2.8 | 0.2.7, 0.2.8         | 0.1.1 à 0.2.5 | oui             | scope GHP                                   |
| plugin-sdk                    | 0.2.7 | 0.2.5 à 0.2.7        | 0.1.0 à 0.2.5 | non             | scope GHP                                   |
| dsl-jsonlogic                 | 0.1.4 | 0.1.3, 0.1.4         | 0.1.0 à 0.1.3 | non             | scope GHP                                   |
| plugin-fiscal                 | 0.4.0 | 0.3.1 à 0.3.3, 0.4.0 | 0.1.0 à 0.3.0 | oui             | scope GHP                                   |
| mcp-server                    | 0.2.8 | 0.2.8, **0.3.0**     | 0.1.0 à 0.2.6 | non             | scope GHP                                   |
| decision-graph (`@run-iq/dg`) | 0.1.2 | 0.1.1, 0.1.2         | aucune        | oui             | scope GHP                                   |
| context-engine                | 0.2.1 | 0.2.1                | aucune        | oui             | scope GHP                                   |
| rule-registry                 | 0.1.1 | 0.1.1                | aucune        | oui             | scope GHP                                   |
| policy-engine                 | 0.1.0 | 0.1.0                | aucune        | non             | scope GHP                                   |
| policy-dsl                    | 0.1.0 | 0.1.0                | aucune        | non             | scope GHP                                   |
| policy-graph                  | 0.1.0 | 0.1.0                | aucune        | non             | scope GHP                                   |
| policy-bridge                 | 0.1.0 | 0.1.0                | **0.1.0**     | non             | **`access=public` seul** (pas de scope GHP) |
| cli                           | 0.1.2 | **absent**           | 0.1.0, 0.1.1  | non             | scope GHP                                   |
| server                        | 0.1.4 | **absent**           | 0.1.0, 0.1.1  | non             | scope GHP                                   |
| web-platform                  | 0.3.4 | n/a (privé)          | n/a           | n/a             | aucun                                       |

Constats :

- Seuls 5 paquets ont `publishConfig` ; la cible (Global Constraints) l'exige dans chaque `package.json` publié. Verdict : **adapter** (ajouter aux 9 manquants).
- `policy-bridge` : `.npmrc` sans scope et déjà présent sur npm public (0.1.0). Verdict : **adapter** `.npmrc` ; déprécier la 0.1.0 npm est une action distante, à valider (voir §6).
- npm public contient d'anciennes versions de core, plugin-sdk, dsl-jsonlogic, plugin-fiscal (code source-disponible/propriétaire pour ce dernier), mcp-server, cli, server, policy-bridge. La décision « GitHub Packages seulement » est déjà prise ; le retrait de npm n'est pas faisable (dépublier) au-delà de 72 h : la voie réaliste est `npm deprecate`, action distante soumise à confirmation.
- `cli` et `server` ont `prepublishOnly` mais ne sont sur aucun registre à jour : à décider (publier sur GHP ou rester non publiés). Verdict : **garder** les scripts, **question ouverte**.
- Seul `web-platform` a un workflow CI ; aucun dépôt de bibliothèque n'a de CI (c'est l'objet de la phase 0).
- `mcp-server` : la 0.3.0 est sur GHP alors que `master` local est en 0.2.8 : elle vient de la branche non fusionnée (§2). Une application cliente en dépend déjà.
- Fragilité : `mcp-server/vitest.config.ts` aliase `@run-iq/core` et `@run-iq/plugin-sdk` vers `../core/src` et `../plugin-sdk/src`. Les tests ne passent que si les dépôts sont frères sur disque ; en CI cela cassera. Verdict : **adapter** (retirer l'alias ou checkout des frères).

## 2. Branche `origin/feat/decision-graph-integration` de mcp-server

2 commits (`2b248d7` feat, `d0e3723` licence) au-dessus de `623c44d` (master est à `fad65ac`, 3 commits plus loin : 0.2.7/0.2.8 peerDeps + README). 18 fichiers, +1919 / −69. Divergence réelle : un merge/rebase devra intégrer `187686e` (peerDeps `^0.2.8` / `^0.2.7`) qui touche les mêmes lignes de `package.json`.

**Outils ajoutés (8)** : `compile_graph`, `execute_graph`, `simulate_graph`, `inspect_graph`, `inspect_context`, `explain_graph_result`, `design_graph`, `validate_graph` (total 16 avec les 8 existants).
**Ressources (+2)** : `schema://graph` (`graph-schema.ts`), `graph://examples` (`graph-examples.ts`). **Prompt (+1)** : `orchestration-architect`. Prompts `analyze-text` et `domain-expert` modifiés (section Orchestration, liste des outils graphe).
**`src/engine.ts`** (+119) : crée en plus compiler, orchestrator, graphStore, executionStore (via `@run-iq/dg`, `@run-iq/context-engine`). **`src/index.ts`** : enregistre le tout.
**Dépendances** : `peerDependencies` passent de `^0.2.8`/`^0.2.7` à `file:../context-engine`, `file:../core`, `file:../decision-graph` (nom `@run-iq/dg`), `file:../plugin-sdk`. Le `package-lock.json` référence `../core` etc. **Problème** : des `file:` en peerDependencies sont inutilisables pour un consommateur ; si la 0.3.0 GHP a été publiée telle quelle, ses peers sont invalides (non vérifié : l'API de métadonnées GHP n'a pas été lue avec succès). Une application cliente l'utilise pourtant — à vérifier à la Task 4. Verdict : **adapter** (peers redevenus semver : `^0.2.8`, `^0.1.2`, `^0.2.1`, `^0.2.7`).
**Licence** : `LICENSE` MIT remplacé par un texte BSL 1.1 « MCP Server » (Change Date 2030-01-01, Apache 2.0, grant identique en esprit) ; `package.json` `license` → `SEE LICENSE IN LICENSE`. **Écart avec la cible** (mcp-server doit être MIT). Verdict : **retirer** ce changement de licence lors du merge (garder MIT) — changement de comportement légal, à valider.
**Tests sur la branche** (worktree temporaire, supprimé) : `npm ci` OK (les `file:../` se résolvent par liens symboliques ; à noter que l'alias vitest suppose aussi des frères). `npm test` : **18 fichiers, 82 tests passent** — même nombre que `master` : **aucun test pour les 8 nouveaux outils, 2 ressources, ni le prompt**. `npm run build` OK ; `tsc --noEmit` OK ; `eslint src` : **2 erreurs** (`_removed` inutilisé dans `design-graph.ts:141`, `CompiledGraph` inutilisé dans `inspect-graph.ts:3`). Verdict : fusionner après correction lint, peers et licence ; ajouter des tests (phase 1).
**Usage par une application cliente** (lecture seule) : elle lance `mcp-server` en sidecar stdio et expose **dynamiquement** tous ses outils (`listTools`), sans nom d'outil codé en dur, ni référence à `compile_graph` & co. Elle utilise donc les outils graphe sans en dépendre nominativement : fusionner ne casse rien ; retirer les outils graphe changerait la liste exposée à son LLM. Elle dépend aussi de dg, context-engine, policy-*, rule-registry.

## 3. web-platform

- `npm ci` échoue : `package.json` demande `core ^0.2.7`, `dsl-jsonlogic ^0.1.3`, `plugin-fiscal ^0.3.1`, `plugin-sdk ^0.2.5`, mais `package-lock.json` est figé sur 0.2.5 / 0.1.2 / 0.3.0 / 0.2.4 avec des URL `registry.npmjs.org` (reproduit en copie dans le scratchpad : `ERESOLVE`, peer `core ^0.2.6` de dsl-jsonlogic 0.1.3 non satisfait). Cause : le dernier commit `1491c9c` a monté les versions sans régénérer le lockfile. De plus : pas de `.npmrc`, donc ces versions (publiées sur GHP seulement) ne sont pas résolvables, et `plugin-fiscal` est privé.
- `.github/workflows/deploy.yml` : sur push `master` ou manuel, Node 20, `npm ci`, `npm run build` (Next `output: 'export'` → `out/`), upload artefact Pages et `deploy-pages`. Aucun token de registre → échouera tant que le lockfile/registre n'est pas corrigé.
- Verdict : **garder** le workflow (déploiement Pages utile) ; **adapter** : `.npmrc` GHP + `NODE_AUTH_TOKEN`/`packages: read` dans le workflow, lockfile régénéré. Question ouverte : une action Pages publique qui installe un paquet privé (`plugin-fiscal`) exige un PAT ; ou rendre web-platform indépendant de `plugin-fiscal`.

## 4. Licences

| Paquet                  | LICENSE actuel                       | champ `license` | Cible        | Écart                                               |
| ----------------------- | ------------------------------------ | --------------- | ------------ | --------------------------------------------------- |
| core                    | BSL 1.1                              | SEE LICENSE     | BSL          | aucun                                               |
| decision-graph          | BSL 1.1                              | SEE LICENSE     | BSL          | aucun                                               |
| rule-registry           | BSL 1.1                              | SEE LICENSE     | BSL          | aucun                                               |
| context-engine          | BSL 1.1                              | SEE LICENSE     | **MIT**      | **BSL → MIT**                                       |
| plugin-sdk              | MIT                                  | MIT             | MIT          | aucun                                               |
| dsl-jsonlogic           | MIT                                  | MIT             | MIT          | aucun                                               |
| cli                     | MIT                                  | MIT             | MIT          | aucun                                               |
| mcp-server              | MIT (master)                         | MIT             | MIT          | aucun sur master ; la branche passe en BSL (écart)  |
| web-platform            | aucun                                | absent          | MIT          | **ajouter**                                         |
| plugin-fiscal           | Run-IQ Source-Available License v1.0 | SEE LICENSE     | propriétaire | à reconfirmer (« source-available » ≠ propriétaire) |
| server                  | MIT                                  | MIT             | **BSL**      | **MIT → BSL**                                       |
| policy-engine           | **fichier absent**                   | BSL-1.1         | BSL          | ajouter LICENSE                                     |
| policy-bridge           | **fichier absent**                   | BSL-1.1         | BSL          | ajouter LICENSE                                     |
| policy-dsl              | **fichier absent**                   | MIT             | **MIT**      | ajouter LICENSE                                     |
| policy-graph            | **fichier absent**                   | MIT             | MIT          | ajouter LICENSE                                     |
| spec, integration-tests | n'existent pas                       |                 | MIT          | à créer                                             |

Changements de licence existants à valider : `context-engine` BSL → MIT (relicencier une version déjà publiée sur GHP : ne vaut que pour les versions futures) et `server` MIT → BSL (la 0.1.x npm publique restera MIT). Verdict : **adapter** selon la cible, sur confirmation.

## 5. Changements à valider

1. Fusionner `feat/decision-graph-integration` dans mcp-server `master` (8 outils, 2 ressources, 1 prompt), après : peers `file:../` → semver, correction des 2 erreurs eslint, rebase sur `fad65ac`. Pas de retrait de fonctionnalité.
2. **Annuler** le passage de mcp-server en BSL (rester MIT, conforme à la cible) — retrait d'un changement de la branche.
3. Licences : `context-engine` BSL → MIT ; `server` MIT → BSL ; ajouter les `LICENSE` manquants (policy-*, web-platform).
4. `plugin-fiscal` : confirmer « propriétaire » (licence actuelle source-available).
5. Ajouter `publishConfig` GHP aux 9 paquets qui n'en ont pas ; corriger `.npmrc` de policy-bridge (comportement de publication modifié).
6. Retirer l'alias vitest vers `../core/src` de mcp-server (comportement des tests).
7. web-platform : `.npmrc` GHP, lockfile régénéré, accès token dans `deploy.yml` (ou découpler de `plugin-fiscal`).
8. Actions distantes à confirmer séparément : `npm deprecate` des versions npm public (core, plugin-sdk, dsl-jsonlogic, plugin-fiscal, mcp-server, cli, server, policy-bridge) ; décider si `cli` et `server` sont publiés sur GHP.
9. Vérifier que la 0.3.0 GHP de mcp-server (peers `file:`) est installable ; sinon publier une 0.3.1 corrigée (confirmation requise).
