# imgen-storybook — silnik ilustracji do opowiadań

Biblioteka do wbudowania w aplikację AI do tworzenia ilustrowanych opowiadań.
Zamiast płaskiej listy promptów (`assets[]`) operuje na **definicjach**: bohaterach, stylach,
lokacjach, akcesoriach, scenach i opowiadaniach. Z tych definicji składa prompt i renderuje
ilustracje przez FAL.

Składa się z dwóch warstw:

1. **Biblioteka TypeScript** (`imgen-storybook`) — `StoryEngine`: CRUD encji z walidacją i integralnością powiązań,
   obrazy referencyjne, składanie promptów, renderowanie, historia renderów, adapter storage.
2. **Warstwa GraphQL** (`imgen-storybook/graphql`) — schemat z mutacjami (`createCharacter`, `renderScene`,
   `selectSceneRender`…), który podpinasz do dowolnego serwera (GraphQL Yoga, Apollo, Envelop).

```
 aplikacja ──GraphQL──▶ createStoryGraphQLSchema ─┐
 aplikacja ──import───────────────────────────────┴─▶ StoryEngine
                                                       ├─ domain (zod)        walidacja + typy
                                                       ├─ prompt/composer     prompt + plan referencji
                                                       ├─ providers           FAL (gemini / flux), mock
                                                       ├─ postprocess         rembg, auto-crop, resize
                                                       └─ storage adapter     rekordy JSON + bloby
```

## Instalacja

Wymagania: Node.js ≥ 18.17.

```bash
npm install github:researchanddeploy/imgen-storybook   # buduje dist/ przy instalacji (skrypt prepare)
```

Klucz FAL: `FAL_KEY` w środowisku (zob. `.env.example`) albo `createFalImageProvider({ apiKey })`.

---

## Model domeny

| Encja | Najważniejsze pola | Rola w prompcie |
|---|---|---|
| **Character** (bohater) | `appearance` (gatunek, wiek, włosy, oczy, cechy…), `outfit`, `personality`, `defaultAccessoryIds` | blok w sekcji CHARACTERS |
| **Style** (styl) | `medium`, `palette`, `lineWork`, `shading`, `lighting`, `texture`, `mood`, `negative`, `allowText`, `generation` | sekcja ART STYLE + ustawienia generacji |
| **Location** (lokacja) | `setting`, `era`, `keyFeatures`, `palette`, `defaultTimeOfDay`, `defaultWeather` | sekcja SETTING |
| **Accessory** (akcesorium/rekwizyt) | `category`, `material`, `colors`, `size`, `ownerCharacterId` | przy bohaterze („Carries / wears”) albo w PROPS |
| **Scene** (scena) | `storyId`, `styleId`, `locationId`, `cast[]`, `accessoryIds`, `camera`, `timeOfDay`, `weather`, `lighting`, `mood`, `narrative`, `negative`, `generation` | cały prompt ilustracji |
| **Story** (opowiadanie) | `synopsis`, `audience`, `styleId`, `sceneOrder`, `generation` | kontekst, styl domyślny, okładka |
| **Render** | `target`, `status`, `prompt`, `references`, `endpoint`, `params`, `image` | zapis jednej generacji |

Wspólne pola wszystkich encji: `id`, `name`, `description`, `tags`, `promptHint` (dowolny tekst
doklejany przy opisie encji), `references` (obrazy referencyjne), `createdAt`, `updatedAt`.

`cast[]` w scenie to lista `{ characterId, action, expression, pose, position, outfit, accessoryIds, includeDefaultAccessories }`:
bohater może mieć w danej scenie inny strój, dodatkowe akcesoria albo nie nieść swoich domyślnych.

Dziedziczenie:

- styl sceny: `scene.styleId` → `story.styleId`,
- pora dnia / pogoda: scena → domyślne lokacji,
- ustawienia generacji (`aspectRatio`, `resolution`, `outputFormat`, `endpoint`, `editEndpoint`):
  domyślne silnika → styl → opowiadanie → scena → opcje wywołania (późniejsze wygrywają).

Integralność: nie da się zapisać sceny wskazującej nieistniejącego bohatera itp. Usunięcie encji,
z której coś korzysta, kończy się błędem `IN_USE`. `force: true` usuwa ją i odpina od zależnych encji.
Scena dołącza do opowiadania przez `storyId`, a `story.sceneOrder` utrzymuje kolejność automatycznie.

---

## Spójność wizualna = obrazy referencyjne od użytkownika

Wygląd bohaterów, akcesoriów i lokacji definiują **obrazy referencyjne wgrane przez użytkownika**
(`addReferenceImage`). Przy każdym renderze sceny silnik:

1. zbiera encje w kolejności priorytetu: bohaterowie z `cast` → ich akcesoria → rekwizyty sceny → lokacja → styl,
2. dobiera obrazy w budżecie (`maxReferences`, domyślnie 10; `maxPerEntity`, domyślnie 3) **round-robin**:
   najpierw obraz główny (`isPrimary`) każdej encji, dopiero potem kolejne, więc w tłocznej scenie
   żaden bohater nie wypada,
3. dokleja do promptu legendę („Image 1: character "Ala" (front)…”) i reguły: referencje są wzorcem
   tożsamości, ale nie kopiuje się ich tła ani pozy, a próbki stylu definiują tylko technikę,
4. jeśli są referencje, woła endpoint z obrazami (`fal-ai/gemini-3-pro-image-preview/edit`),
   a jeśli nie ma żadnej, zwykły text-to-image (`fal-ai/gemini-3-pro-image-preview`).

Silnik sam nie generuje arkuszy postaci. Jeśli użytkownik nie ma jeszcze obrazka bohatera, może
wygenerować podgląd (`renderEntityPreview`) i świadomie zatwierdzić go jako referencję
(`promoteRenderToReference`).

`composeScenePrompt` to dry run: zwraca dokładnie ten prompt i listę obrazów, które poszłyby do modelu.
Przydaje się w UI („co wyśle AI”) i przy debugowaniu.

---

## Szybki start — biblioteka

```ts
import { createStoryEngine, createFileSystemStorage, createFalImageProvider } from "imgen-storybook";

const engine = createStoryEngine({
    storage: createFileSystemStorage({ rootDir: "./story-data" }),
    provider: createFalImageProvider(), // FAL_KEY z env albo { apiKey }
    defaults: { aspectRatio: "4:3", resolution: "1K" },
});

const style = await engine.styles.create({
    name: "Akwarela",
    medium: "soft watercolor children's book illustration",
    palette: ["warm ochre", "sea blue"],
    negative: ["photorealism"],
    generation: { aspectRatio: "3:4" },
});
const ala = await engine.characters.create({
    name: "Ala",
    appearance: { age: "7", hair: "two red braids", distinguishingFeatures: ["freckles"] },
    outfit: "yellow raincoat",
});
await engine.addReference({ kind: "character", entityId: ala.id, image: { data: fileBuffer }, view: "front" });

const story = await engine.stories.create({ name: "Deszczowy dzień", audience: "dzieci 4-7", styleId: style.id });
const harbor = await engine.locations.create({ name: "Port", keyFeatures: ["latarnia", "drewniane molo"] });
const scene = await engine.scenes.create({
    name: "Spotkanie z mewą",
    storyId: story.id,
    locationId: harbor.id,
    description: "Ala spotyka gadającą mewę na końcu mola",
    cast: [{ characterId: ala.id, expression: "zaskoczona", position: "lewy pierwszy plan" }],
    camera: { shot: "wide", angle: "eye level" },
});

const [render] = await engine.renderScene(scene.id, { count: 1 });
if (render.status === "succeeded") {
    const blob = await engine.getBlob(render.image!.blobKey); // { data: Buffer, contentType }
}
```

`renderScene` / `renderEntityPreview` **nie rzucają** przy błędzie providera. Zwracają render ze
`status: "failed"` i `error`, a próba zostaje w historii. Pierwszy udany render staje się
`selectedRenderId` sceny, jeśli scena nie miała jeszcze wybranej ilustracji.

Opcje renderu: `count` (1–4 kandydatów), `generation` (nadpisania), `extraInstructions`,
`referenceBudget`, `postProcess` (`removeBackground`, `autoCrop`, `resize`), `providerOptions`
(surowe pola doklejane do wejścia endpointu FAL), a dla podglądów encji także `styleId` i `framing`.

---

## GraphQL

```ts
import { createYoga } from "graphql-yoga";
import { createStoryGraphQLSchema } from "imgen-storybook/graphql";

// jeden silnik:
const schema = createStoryGraphQLSchema({ engine });
// albo silnik per request (np. osobny katalog/bucket na użytkownika):
const schema2 = createStoryGraphQLSchema({ getEngine: (ctx) => enginesByUser.get(ctx.userId) });

createYoga({ schema });
```

Pełne SDL leży w [`schema.graphql`](schema.graphql) (do codegen po stronie aplikacji;
regeneracja: `npm run schema`). Lokalny serwer z GraphiQL: `npm run example:server`
(używa FAL, gdy jest `FAL_KEY`, w przeciwnym razie mock-providera).

### Mutacje

| Grupa | Mutacje |
|---|---|
| encje | `create/update/delete` × `Character`, `Style`, `Location`, `Accessory`, `Scene`, `Story` |
| referencje | `addReferenceImage`, `updateReferenceImage`, `removeReferenceImage` |
| generowanie | `renderScene`, `renderEntityPreview` |
| wybór i porządki | `selectSceneRender`, `deleteRender`, `promoteRenderToReference` |

Zapytania: pojedyncze i listy encji (`characters(tag)`, `scenes(storyId, tag)`…), `entity(kind, id)`,
`render`, `renders(targetKind, targetId)`, `composeScenePrompt`, `composeEntityPreviewPrompt`.
Typy rozwiązują powiązania (`Scene.cast.character`, `Scene.effectiveStyle`, `Story.scenes`,
`Scene.selectedRender`, `Render.target.entity`…).

Semantyka `update*`: pominięte pole zostaje bez zmian, `null` czyści pole, obiekty zagnieżdżone
(`appearance`, `camera`, `generation`) są **scalane** (w nich `null` czyści pojedyncze pole), listy są
**zastępowane** w całości.

### Przykładowy przepływ

```graphql
mutation { createCharacter(input: { id: "ala", name: "Ala", appearance: { hair: "two red braids" } }) { id } }

mutation ($img: String!) {
  addReferenceImage(input: { kind: CHARACTER, entityId: "ala", image: { base64: $img }, view: "front" }) {
    id isPrimary
  }
}

mutation {
  createScene(input: {
    name: "Molo", storyId: "rainy-day", locationId: "harbor",
    description: "Ala spotyka mewę",
    cast: [{ characterId: "ala", expression: "zaskoczona" }]
  }) { id }
}

query { composeScenePrompt(sceneId: "molo") { prompt references { index entityName } } }

mutation {
  renderScene(sceneId: "molo", options: { count: 2 }) {
    id status error image { url width height }
  }
}

mutation { selectSceneRender(sceneId: "molo", renderId: "rnd_…") { selectedRender { id } } }
```

Obraz w odpowiedzi to `StoredImage { url, dataUri, mimeType, width, height }`. `url` istnieje, gdy
adapter storage wystawia publiczne adresy. `dataUri` jest ciężkie, więc pobieraj je tylko wtedy, gdy
nie ma `url`. Kody błędów w `extensions.code`: `NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`, `IN_USE`,
`PROVIDER_ERROR`.

---

## Storage adapter

```ts
interface StorageAdapter {
    records: RecordStore; // get/list/put/delete dokumentów JSON wg (kind, id)
    blobs: BlobStore;     // put/get/delete binariów wg klucza + opcjonalne publicUrl(key)
}
```

W pakiecie są dwa adaptery:

- `createFileSystemStorage({ rootDir, publicBaseUrl? })`: rekordy w `rootDir/records/<kind>/<id>.json`,
  obrazy w `rootDir/blobs/<klucz>`, zapis atomowy (tmp + rename). Przeznaczony dla jednego procesu,
  bez blokad między procesami.
- `createMemoryStorage()`: do testów i prototypów.

Własny adapter (Postgres/Supabase, S3, GCS…) to dwie klasy implementujące te interfejsy, bez zmian
w silniku. Klucze blobów wyglądają tak: `references/<kind>/<entityId>/<refId>.png` i `renders/<renderId>.png`.

---

## Konfiguracja silnika

| Opcja | Domyślnie | Opis |
|---|---|---|
| `storage` | — | adapter storage |
| `provider` | — | `createFalImageProvider()` / `createMockImageProvider()` / własny `ImageProvider` |
| `backgroundRemover` | brak | `createFalBackgroundRemover()` lub `createWaveSpeedBackgroundRemover()`; potrzebny do `postProcess.removeBackground` |
| `defaults` | `4:3`, `1K`, `png` | domyślne ustawienia generacji |
| `referenceBudget` | `10` / `3` na encję | budżet obrazów referencyjnych |
| `referenceTransport` | `data-uri` | `public-url` wysyła do providera URL z `publicUrl()`, czyli mniejsze żądania, ale adres musi być osiągalny dla FAL (nie localhost) |
| `allowReferenceUrl` | brak (URL-e wyłączone) | hook zatwierdzający pobieranie referencji z URL (ochrona przed SSRF) |
| `maxReferenceBytes` | 15 MB | limit pojedynczego obrazu referencyjnego |

Akceptowane formaty referencji: PNG, JPEG, WebP (format sprawdza `sharp`, a nie rozszerzenie pliku).

---

## Ograniczenia i uwagi

- **Brak autoryzacji.** Moduł zakłada, że aplikacja sprawdza uprawnienia przed wywołaniem
  (np. w `getEngine(ctx)` albo w middleware serwera GraphQL).
- **Render jest synchroniczny.** Generacja w FAL trwa zwykle 10–60 s, a mutacja `renderScene` czeka na
  wynik. Przy dużym ruchu warto wołać silnik z kolejki zadań i odpytywać `renders`.
- Wyniki FAL (`sourceUrl`) są tymczasowe. Trwała kopia zawsze trafia do blob store.
- W środowiskach z proxy HTTP natywny `fetch` w Node wymaga `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## Rozwój

```bash
npm install
npm test            # vitest (mock provider, bez sieci)
npm run typecheck   # src + testy + przykłady
npm run build       # dist/
npm run schema      # regeneruje schema.graphql
```

## Licencja

[MIT](LICENSE)
