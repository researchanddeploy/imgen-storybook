# imgen-storybook — silnik ilustracji do opowiadań

Serwis do wbudowania w aplikację AI tworzącą ilustrowane opowiadania. Operuje na **definicjach**:
bohaterach, stylach, lokacjach, akcesoriach, scenach i opowiadaniach. Z tych definicji składa
prompt, dołącza obrazy referencyjne użytkownika i generuje ilustracje modelami na FAL.
Docelowo działa na **FAL Serverless** jako kontener z serwerem GraphQL.

```
 aplikacja ──HTTP/GraphQL──▶ serwer (FAL Serverless, kontener Node 22)
                               │  /graphql   mutacje i zapytania
                               │  /blobs     podpisane linki do obrazów
                               │  /webhooks  powiadomienia o gotowych renderach (opcjonalnie)
                               ▼
                             StoryEngine ── prompt/composer   prompt + plan referencji
                               │         ── providers         kolejka FAL, upload, recenzent
                               │         ── postprocess       rembg, crop, resize
                               ▼
                             storage: /data (pliki) lub Postgres (rekordy) + /data (obrazy)
```

Można go też używać bez serwera, jako biblioteki TypeScript (`imgen-storybook`) albo samego schematu
GraphQL (`imgen-storybook/graphql`) podpiętego do własnego serwera.

---

## Klucz API (placeholder)

Klucz FAL ustawiasz w jednym miejscu, a do tego czasu w `.env.example` stoi placeholder:

```bash
FAL_KEY=__SET_YOUR_FAL_KEY__
```

Każda wartość w formie `__SET_…__` (także pusta) jest traktowana jak **brak klucza**. Serwer startuje
normalnie, `/health` pokazuje `"falKeyConfigured": false`, a próba renderu kończy się renderem `FAILED`
z komunikatem, jak ustawić klucz. Placeholder nigdy nie trafia do FAL.

- **Lokalnie:** `cp .env.example .env` i wpisz klucz w `FAL_KEY`.
- **Na FAL Serverless:** `fal secrets set FAL_KEY=<klucz>` (sekrety trafiają do kontenera jako zmienne środowiskowe).
- **W kodzie:** `createFalImageProvider({ apiKey })`.

To samo dotyczy `STORYBOOK_API_TOKEN` i `WAVESPEED_API_KEY`.

---

## Deploy na FAL Serverless

Konfiguracja leży w [`pyproject.toml`](pyproject.toml) (zweryfikowana parserem z SDK `fal` 1.81)
i [`Dockerfile`](Dockerfile). FAL buduje obraz u siebie i kieruje ruch na port 8080 kontenera.

```bash
pip install fal
fal auth login
fal secrets set FAL_KEY=<klucz FAL>
fal secrets set STORYBOOK_API_TOKEN=<losowy sekret>   # opcjonalnie, zob. niżej
fal deploy imgen-storybook
```

| Ustawienie (`[tool.fal.apps.imgen-storybook]`) | Wartość | Po co |
|---|---|---|
| `auth` | `private` | wywołujący musi podać klucz FAL (`Authorization: Key …`) |
| `machine_type` | `S` | CPU; serwer nie potrzebuje GPU, generacja dzieje się w modelach FAL |
| `exposed_port` | `8080` | tryb „direct server”: FAL przekazuje ruch do Node |
| `keep_alive` | `300` | runner żyje 5 min po ostatnim żądaniu, żeby polling dokończył rendery |
| `max_multiplexing` | `32` | jeden proces Node obsługuje wiele żądań naraz |
| `health_check.path` | `/health` | |

**Dane:** domyślnie wszystko trafia na trwały wolumen FAL `/data` (`STORYBOOK_DATA_DIR=/data/storybook`),
współdzielony przez runnery. Zapis jest atomowy (plik tymczasowy + rename). Przy wielu runnerach
i dużym ruchu ustaw `DATABASE_URL` (np. Supabase/Neon), a wtedy rekordy idą do Postgresa z atomową
blokadą wersji, a obrazy zostają na `/data`. Tabele tworzą się same przy starcie.

**Dwa tryby wystawienia:**

1. **`auth = "private"` (domyślnie):** API woła backend Twojej aplikacji z kluczem FAL. Gotowe rendery
   wykrywa polling w serwerze (co `STORYBOOK_POLL_INTERVAL_MS`) oraz każde zapytanie `render(id)`.
   Webhooki są wyłączone, bo FAL nie dołącza klucza do wywołań zwrotnych.
2. **`auth = "public"` + `STORYBOOK_API_TOKEN`:** API chroni nagłówek `x-storybook-token`. Możesz wtedy
   włączyć webhooki (`STORYBOOK_WEBHOOKS=1`, `STORYBOOK_PUBLIC_URL=https://fal.run/<user>/imgen-storybook`).

Uwaga: obraz zbudowałem w tym środowisku tylko częściowo, bo `apt-get` w trakcie budowania nie miał
dostępu do sieci. Skompilowany serwer uruchomiłem w obrazie `node:22-bookworm-slim` i sprawdziłem
`/health`, GraphQL, zapis na `/data` i przetwarzanie obrazów przez `sharp`. Pełny `fal deploy`
i generacja na żywym FAL czekają na test po integracji.

---

## HTTP API serwera

| Ścieżka | Opis |
|---|---|
| `GET /health` | status, czy klucz FAL jest ustawiony, rodzaj storage |
| `POST /graphql` | całe API (schemat: [`schema.graphql`](schema.graphql)) |
| `GET /blobs/<tenant>/<klucz>?exp=…&sig=…` | obrazy; linki są podpisane HMAC i wygasają po godzinie, więc działają w `<img src>` |
| `POST /webhooks/fal/<tenant>/<renderId>?token=…` | wywołanie zwrotne FAL; treść nie jest zaufana, a wynik jest pobierany z FAL |

Nagłówki:

- `x-storybook-token`: wymagany, jeśli ustawiono `STORYBOOK_API_TOKEN`.
- `x-storybook-tenant`: oddzielna przestrzeń danych (np. id użytkownika). Domyślnie `default`.
  Tenanci nie widzą nawzajem swoich danych.

Lokalnie ten sam serwer startujesz przez `npm run dev`. Bez prawdziwego `FAL_KEY` używa mock-providera,
który zwraca kolorowe prostokąty, więc da się budować UI bez kosztów.

---

## Model domeny

| Encja | Najważniejsze pola |
|---|---|
| **Character** (bohater) | `appearance` (gatunek, wiek, włosy, oczy, cechy…), `outfit`, `personality`, `defaultAccessoryIds` |
| **Style** (styl) | `medium`, `palette`, `lineWork`, `shading`, `lighting`, `texture`, `mood`, `negative`, `allowText`, `generation` |
| **Location** (lokacja) | `setting`, `era`, `keyFeatures`, `palette`, `defaultTimeOfDay`, `defaultWeather` |
| **Accessory** (akcesorium) | `category`, `material`, `colors`, `size`, `ownerCharacterId` |
| **Scene** (scena) | `storyId`, `styleId`, `locationId`, `cast[]`, `accessoryIds`, `camera`, `timeOfDay`, `weather`, `lighting`, `mood`, `narrative`, `negative`, `generation`, `referenceSelections`, `continuity` |
| **Story** (opowiadanie) | `synopsis`, `audience`, `styleId`, `sceneOrder`, `generation` |
| **Render** | `status`, `operation` (generate/refine/upscale), `parentRenderId`, `prompt`, `references`, `image`, `review`, `estimatedCostUsd` |

Wspólne pola: `id`, `version`, `name`, `description`, `tags`, `promptHint`, `references`, `createdAt`, `updatedAt`.

`cast[]` to `{ characterId, action, expression, pose, position, outfit, accessoryIds, includeDefaultAccessories, referenceIds }`.

Dziedziczenie: styl sceny → styl opowiadania. Pora dnia i pogoda: scena → lokacja. Ustawienia generacji:
silnik → styl → opowiadanie → scena → wywołanie (późniejsze wygrywają).

Integralność: nie da się wskazać nieistniejącej encji ani obrazu referencyjnego. Usunięcie używanej
encji zwraca błąd `IN_USE`, a z `force: true` encja jest odpinana od zależnych. `story.sceneOrder`
aktualizuje się sam.

---

## Spójność wizualna

Wygląd definiują **obrazy referencyjne wgrane przez użytkownika** (`addReferenceImage`):

- **Przygotowanie:** przy zapisie obraz jest obracany zgodnie z EXIF i zmniejszany do 1536 px
  (`maxReferenceDimension`). Zdjęcie z telefonu waży wtedy setki KB zamiast kilku MB.
- **Upload raz:** przy pierwszym użyciu referencja trafia do storage FAL, a URL jest zapamiętywany na
  referencji i odświeżany przed wygaśnięciem. Żądania do modelu zawierają linki, nie megabajty base64.
- **Budżet:** domyślnie 10 obrazów na render i 3 na encję, przydzielane round-robin, czyli każdy
  bohater dostaje swój obraz główny, zanim ktokolwiek dostanie drugi.
- **Wybór per scena:** `cast[].referenceIds` (np. zimowy strój bohatera) i `referenceSelections` dla
  lokacji czy akcesoriów.
- **Ciągłość stron:** `continuity.fromPreviousScene` dołącza wybraną ilustrację poprzedniej strony,
  a `continuity.sceneIds` ilustracje wskazanych scen. Służą jako kotwica stylu, światła i palety, nie
  do kopiowania kompozycji, i zajmują najwyżej 1/3 budżetu.
- **Legenda w prompcie:** „Image 1: character "Ala" (front)…” plus reguły, jak traktować każdy rodzaj obrazu.

Silnik sam nie generuje arkuszy postaci. `renderEntityPreview` tworzy podgląd, a
`promoteRenderToReference` świadomie zapisuje go jako referencję.

---

## Renderowanie (asynchroniczne)

Mutacje renderujące **wracają od razu** z renderami w statusie `QUEUED`. Żadne żądanie nie czeka
10–60 s, co jest wymagane na serverless.

```
renderScene / renderEntityPreview / refineRender / upscaleRender
   └─▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED (obraz w storage, review, auto-wybór)
                          └─▶ FAILED (błąd, timeout) / CANCELED
```

- **Śledzenie stanu:** stan odświeża zapytanie `render(id)`, mutacja `syncRender`, polling serwera
  albo webhook. Wszystkie są idempotentne i bezpieczne przy wielu runnerach.
- **`count` 1–4:** jedno zadanie FAL daje kilka renderów-kandydatów.
- **Auto-wybór:** pierwszy udany render (niezablokowany przez recenzenta) zostaje ilustracją sceny,
  jeśli żadna nie była wybrana. Zmienisz ją przez `selectSceneRender`.
- **`refineRender(renderId, { instructions })`:** poprawka istniejącej ilustracji. Obraz idzie jako
  „Image 1”, a referencje postaci zostają dołączone, żeby edycja nie rozjechała wyglądu.
- **`upscaleRender(renderId, { scale })`:** powiększenie do druku.
- **Ponawianie:** błędy przejściowe (sieć, 429, 5xx) są ponawiane z backoffem. Zadanie wiszące dłużej
  niż `renderTimeoutMs` (domyślnie 15 min) jest anulowane w FAL i oznaczane jako `FAILED`.
- **Limity:** `STORYBOOK_MAX_CONCURRENT_RENDERS`, `STORYBOOK_MAX_RENDERS_PER_DAY` i
  `STORYBOOK_MAX_DAILY_COST_USD` (wymaga cennika `STORYBOOK_PRICING`, np. `{"fal-ai/gemini-3-pro-image-preview/edit":0.15}`).
  Przekroczenie zwraca błąd `RATE_LIMITED`. Limity liczą się per tenant.
- **Recenzent:** `STORYBOOK_REVIEWER=fal-vision` po każdym renderze ocenia przez model wizyjny na FAL,
  czy treść pasuje do odbiorców (`flagged`) i do opisu (`consistencyScore`, `issues`).
  Oflagowany render nie jest auto-wybierany.

---

## GraphQL — skrót

| Grupa | Operacje |
|---|---|
| encje | `create/update/delete` × `Character`, `Style`, `Location`, `Accessory`, `Scene`, `Story`; `update*(…, expectedVersion)` |
| referencje | `addReferenceImage`, `updateReferenceImage`, `removeReferenceImage`, `promoteRenderToReference` |
| generowanie | `renderScene`, `renderEntityPreview`, `refineRender`, `upscaleRender` |
| stan | `render(id)`, `renders(...)`, `syncRender`, `syncPendingRenders`, `cancelRender`, `reviewRender` |
| wybór | `selectSceneRender`, `deleteRender` |
| podgląd | `composeScenePrompt`, `composeEntityPreviewPrompt` (dry run, za darmo) |
| agent LLM | `toolDefinitions(format: ANTHROPIC \| OPENAI)` |

- **Listy** są stronicowane: `characters(first, after) { items nextCursor }`.
- **Blokada optymistyczna:** każda encja ma `version`. `update*(…, expectedVersion: n)` zwraca
  `CONFLICT`, jeśli ktoś (np. agent i użytkownik naraz) zmienił ją w międzyczasie.
- **Semantyka `update*`:** pominięte pole zostaje, `null` czyści pole, obiekty zagnieżdżone są scalane,
  listy zastępowane.
- **Powiązania** (`Scene.cast.character`, `Story.scenes`…) są ładowane zbiorczo przez DataLoader, bez
  zapytania na każde pole.
- **Kody błędów:** `NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`, `IN_USE`, `RATE_LIMITED`, `PROVIDER_ERROR`, `CONFIGURATION_ERROR`.

```graphql
mutation { createCharacter(input: { id: "ala", name: "Ala", appearance: { hair: "two red braids" } }) { id version } }

mutation ($img: String!) {
  addReferenceImage(input: { kind: CHARACTER, entityId: "ala", image: { base64: $img }, view: "front" }) { id width height }
}

mutation {
  createScene(input: {
    id: "pier", name: "Molo", storyId: "rainy-day", locationId: "harbor",
    description: "Ala spotyka mewę",
    cast: [{ characterId: "ala", expression: "zaskoczona" }],
    continuity: { fromPreviousScene: true }
  }) { id }
}

mutation { renderScene(sceneId: "pier", options: { count: 2 }) { id status } }   # → QUEUED

query { render(id: "rnd_…") { status error image { url width height } review { flagged issues } } }

mutation { refineRender(renderId: "rnd_…", input: { instructions: "niech Ala się uśmiecha" }) { id status } }
```

---

## Agent LLM

Definicje narzędzi powstają z tych samych schematów zod, którymi silnik waliduje dane, więc model
widzi dokładnie akceptowany kształt wejścia:

```ts
import { getStoryToolDefinitions, executeStoryTool } from "imgen-storybook";

const tools = getStoryToolDefinitions("anthropic");          // albo "openai"
// …model zwraca tool_use { name, input } …
const result = await executeStoryTool(engine, name, input);   // { ok, result } | { ok: false, error }
```

Narzędzia: `list_entities`, `get_entity`, `create_*`, `update_*` (z `expectedVersion`), `delete_*`,
`compose_scene_prompt`, `render_scene`, `render_entity_preview`, `refine_render`, `get_render`,
`select_scene_render`. `executeStoryTool` nigdy nie rzuca wyjątkiem: błąd wraca jako dane, które model może przeczytać.

---

## Biblioteka TypeScript

```bash
npm install github:researchanddeploy/imgen-storybook
```

```ts
import { createStoryEngine, createFileSystemStorage, createFalImageProvider } from "imgen-storybook";

const engine = createStoryEngine({
    storage: createFileSystemStorage({ rootDir: "./story-data" }),
    provider: createFalImageProvider(),            // FAL_KEY z env
    defaults: { aspectRatio: "4:3", resolution: "1K" },
    limits: { maxConcurrentRenders: 8 },
});
const stop = engine.startPolling(5000);            // albo wołaj engine.syncPendingRenders() z harmonogramu

const [queued] = await engine.renderScene(sceneId);
const done = await engine.waitForRender(queued.id); // w skryptach; w API zwracaj queued od razu
```

Storage: `createMemoryStorage()`, `createFileSystemStorage({ rootDir })`, a dla Postgresa
`{ records: new PostgresRecordStore({ client: pool, namespace }), blobs: … }` po wcześniejszym
`migratePostgresStorage(pool)`. Własny adapter implementuje `RecordStore` (get, getMany, query, count,
put z `expectedVersion`, delete) i `BlobStore`.

---

## Konfiguracja (zmienne środowiskowe)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `FAL_KEY` | placeholder | klucz FAL (`FALAI_API_KEY` też działa) |
| `STORYBOOK_DATA_DIR` | `/data/storybook` | katalog danych (na FAL: wolumen `/data`) |
| `DATABASE_URL` | — | Postgres dla rekordów |
| `STORYBOOK_API_TOKEN` | — | wymagany nagłówek `x-storybook-token` i sekret podpisów linków |
| `STORYBOOK_PUBLIC_URL` | — | publiczny adres serwera (linki do obrazów, webhooki) |
| `STORYBOOK_WEBHOOKS` | wył. | `1` włącza webhooki FAL (wymaga `STORYBOOK_PUBLIC_URL`) |
| `STORYBOOK_POLL_INTERVAL_MS` | `5000` | polling oczekujących renderów (`0` wyłącza) |
| `STORYBOOK_MAX_RENDERS_PER_DAY` | — | limit obrazów na dobę (per tenant) |
| `STORYBOOK_MAX_CONCURRENT_RENDERS` | — | limit równoległych renderów |
| `STORYBOOK_MAX_DAILY_COST_USD` | — | dzienny budżet (wymaga `STORYBOOK_PRICING`) |
| `STORYBOOK_PRICING` | — | JSON: endpoint → USD za obraz |
| `STORYBOOK_REVIEWER` | — | `fal-vision` włącza recenzenta |
| `IMGEN_ENDPOINT` | `fal-ai/gemini-3-pro-image-preview` | domyślny endpoint text-to-image |
| `PORT` | `8080` | |

---

## Co jeszcze nie jest zweryfikowane

- **Generacja na żywym FAL** (test zaplanowany po integracji). W testach działa mock kolejki.
- **Endpoint upscalera:** domyślny `fal-ai/esrgan` z wejściem `{ image_url, scale }`. Konfigurowalny
  przez `defaultUpscaleEndpoint` i `buildUpscaleInput`.
- **Recenzent:** domyślny `fal-ai/any-llm/vision` z wejściem `{ prompt, system_prompt, image_url, model }`.
  Konfigurowalny przez `endpoint` i `buildInput`.
- **Ważność uploadów w storage FAL:** przyjęte 24 h (`uploadTtlMs`). Po tym czasie referencja jest wgrywana ponownie.
- **`fal deploy`:** konfiguracja przechodzi parser SDK, ale samego deployu nie wykonałem.

## Rozwój

```bash
npm install
npm test            # vitest: silnik, storage (pamięć/pliki/Postgres przez PGlite), GraphQL, serwer HTTP
npm run typecheck
npm run dev         # lokalny serwer, czyta .env (mock bez prawdziwego FAL_KEY)
npm run build && npm start
npm run schema      # regeneruje schema.graphql
```

## Licencja

[MIT](LICENSE)
