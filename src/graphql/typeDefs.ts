const ENTITY_FIELDS = /* GraphQL */ `
  id: ID!
  kind: EntityKind!
  "Incremented on every change; pass it as expectedVersion to update safely."
  version: Int!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders(first: Int = 10, after: String): RenderPage!
  createdAt: String!
  updatedAt: String!
`;

const page = (type: string) => /* GraphQL */ `
type ${type}Page {
  items: [${type}!]!
  "Pass as 'after' to get the next page; null on the last page."
  nextCursor: String
}
`;

export const typeDefs = /* GraphQL */ `
"""
Kind of a user-defined story entity.
"""
enum EntityKind {
  CHARACTER
  STYLE
  LOCATION
  ACCESSORY
  SCENE
  STORY
}

enum OutputFormat {
  PNG
  JPEG
  WEBP
}

enum RenderStatus {
  "Accepted, waiting in the provider queue."
  QUEUED
  "Being generated."
  RUNNING
  SUCCEEDED
  FAILED
  CANCELED
}

enum RenderOperation {
  GENERATE
  "Edit of an existing render (see parent)."
  REFINE
  "Enlarged copy of an existing render (see parent)."
  UPSCALE
}

enum RenderMode {
  "No reference images — plain text-to-image."
  TEXT_TO_IMAGE
  "Images attached — image-conditioned generation."
  REFERENCE_TO_IMAGE
}

enum ReferenceRole {
  "An entity's reference image."
  ENTITY
  "Another page of the story, for visual continuity."
  CONTINUITY
  "The image being edited or upscaled."
  BASE
}

enum ResizeFit {
  CONTAIN
  COVER
  FILL
  INSIDE
  OUTSIDE
}

enum ResizeKernel {
  NEAREST
  LANCZOS3
}

enum ToolFormat {
  ANTHROPIC
  OPENAI
}

# ---------------------------------------------------------------------------
# Output types
# ---------------------------------------------------------------------------

"""
A stored image (reference or render).
"""
type StoredImage {
  key: String!
  mimeType: String!
  "Public URL, when the server exposes one."
  url: String
  "Inline data: URI. Heavy — request only when no url is available."
  dataUri: String
  width: Int
  height: Int
}

"""
A user-provided image that defines how an entity looks. References are attached to
every render that features the entity.
"""
type ReferenceImage {
  id: ID!
  label: String
  "front / side / back / full body / face / detail / style sample..."
  view: String
  notes: String
  "Primary references are sent first and survive reference-budget trimming."
  isPrimary: Boolean!
  mimeType: String!
  width: Int
  height: Int
  image: StoredImage!
  createdAt: String!
}

interface Entity {
${ENTITY_FIELDS}
}

type GenerationSettings {
  endpoint: String
  editEndpoint: String
  aspectRatio: String
  resolution: String
  outputFormat: OutputFormat
}

type Appearance {
  species: String
  age: String
  gender: String
  bodyType: String
  height: String
  skin: String
  hair: String
  eyes: String
  face: String
  distinguishingFeatures: [String!]!
}

type Character implements Entity {
${ENTITY_FIELDS}
  appearance: Appearance!
  outfit: String
  personality: String
  defaultAccessoryIds: [ID!]!
  defaultAccessories: [Accessory!]!
}

type Style implements Entity {
${ENTITY_FIELDS}
  medium: String
  palette: [String!]!
  lineWork: String
  shading: String
  lighting: String
  texture: String
  mood: String
  negative: [String!]!
  allowText: Boolean!
  generation: GenerationSettings!
}

type Location implements Entity {
${ENTITY_FIELDS}
  setting: String
  era: String
  defaultTimeOfDay: String
  defaultWeather: String
  keyFeatures: [String!]!
  palette: [String!]!
}

type Accessory implements Entity {
${ENTITY_FIELDS}
  category: String
  material: String
  colors: [String!]!
  size: String
  ownerCharacterId: ID
  owner: Character
}

type CastMember {
  characterId: ID!
  character: Character
  action: String
  expression: String
  pose: String
  position: String
  outfit: String
  accessoryIds: [ID!]!
  accessories: [Accessory!]!
  includeDefaultAccessories: Boolean!
  "Reference images of the character chosen for this scene (empty = default choice)."
  referenceIds: [ID!]!
}

type Camera {
  shot: String
  angle: String
  lens: String
  composition: String
}

type ReferenceSelection {
  entityKind: EntityKind!
  entityId: ID!
  referenceIds: [ID!]!
}

type Continuity {
  "Attach the selected illustration of the previous scene in story order."
  fromPreviousScene: Boolean!
  "Attach the selected illustrations of these scenes."
  sceneIds: [ID!]!
}

type Scene implements Entity {
${ENTITY_FIELDS}
  storyId: ID
  story: Story
  styleId: ID
  "Scene style, falling back to the story style."
  effectiveStyle: Style
  locationId: ID
  location: Location
  cast: [CastMember!]!
  accessoryIds: [ID!]!
  accessories: [Accessory!]!
  camera: Camera!
  timeOfDay: String
  weather: String
  lighting: String
  mood: String
  "Story text for this page (not used in prompts)."
  narrative: String
  negative: [String!]!
  generation: GenerationSettings!
  referenceSelections: [ReferenceSelection!]!
  continuity: Continuity!
  selectedRenderId: ID
  selectedRender: Render
}

type Story implements Entity {
${ENTITY_FIELDS}
  synopsis: String
  audience: String
  styleId: ID
  style: Style
  sceneOrder: [ID!]!
  "Scenes in display order."
  scenes: [Scene!]!
  generation: GenerationSettings!
}

${page("Character")}
${page("Style")}
${page("Location")}
${page("Accessory")}
${page("Scene")}
${page("Story")}
${page("Render")}

type RenderTarget {
  kind: EntityKind!
  id: ID!
  entity: Entity
}

type RenderReference {
  "1-based position in the image list sent to the model."
  index: Int!
  role: ReferenceRole!
  entityKind: EntityKind
  entityId: ID
  referenceId: ID
  renderId: ID
  label: String
}

type RenderParams {
  aspectRatio: String!
  resolution: String!
  outputFormat: OutputFormat!
  scale: Float
}

type RenderReview {
  reviewer: String!
  "Judged unsuitable for the story's audience."
  flagged: Boolean!
  "0-1: how well the image matches its description and references."
  consistencyScore: Float
  issues: [String!]!
  "Set when the reviewer itself failed."
  error: String
}

type Render {
  id: ID!
  version: Int!
  target: RenderTarget!
  operation: RenderOperation!
  parentRenderId: ID
  parent: Render
  status: RenderStatus!
  mode: RenderMode!
  prompt: String!
  references: [RenderReference!]!
  provider: String!
  endpoint: String!
  params: RenderParams!
  image: StoredImage
  sourceUrl: String
  error: String
  estimatedCostUsd: Float
  review: RenderReview
  createdAt: String!
  submittedAt: String
  completedAt: String
}

type PlannedReference {
  index: Int!
  role: ReferenceRole!
  entityKind: EntityKind
  entityId: ID
  entityName: String
  referenceId: ID
  renderId: ID
  label: String
  view: String
  description: String
}

type ResolvedGeneration {
  endpoint: String
  editEndpoint: String
  aspectRatio: String!
  resolution: String!
  outputFormat: OutputFormat!
}

"""
Result of a dry run: exactly what a render would send to the model.
"""
type ComposedPrompt {
  prompt: String!
  mode: RenderMode!
  references: [PlannedReference!]!
  generation: ResolvedGeneration!
}

type SyncResult {
  checked: Int!
  completed: Int!
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

input GenerationSettingsInput {
  endpoint: String
  editEndpoint: String
  "e.g. 4:3, 3:4, 1:1, 16:9 or auto"
  aspectRatio: String
  "e.g. 1K, 2K, 4K"
  resolution: String
  outputFormat: OutputFormat
}

input AppearanceInput {
  species: String
  age: String
  gender: String
  bodyType: String
  height: String
  skin: String
  hair: String
  eyes: String
  face: String
  distinguishingFeatures: [String!]
}

input CameraInput {
  shot: String
  angle: String
  lens: String
  composition: String
}

input CastMemberInput {
  characterId: ID!
  action: String
  expression: String
  pose: String
  position: String
  "Overrides the character's default outfit in this scene."
  outfit: String
  "Accessories carried in this scene, on top of the character's defaults."
  accessoryIds: [ID!]
  "false drops the character's default accessories in this scene."
  includeDefaultAccessories: Boolean
  "Which of the character's reference images to use here, in order."
  referenceIds: [ID!]
}

input ReferenceSelectionInput {
  entityKind: EntityKind!
  entityId: ID!
  referenceIds: [ID!]!
}

input ContinuityInput {
  fromPreviousScene: Boolean
  sceneIds: [ID!]
}

"Create inputs: id is optional (generated when omitted)."
input CreateCharacterInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  appearance: AppearanceInput
  outfit: String
  personality: String
  defaultAccessoryIds: [ID!]
}

"Update inputs: omitted fields stay, null clears a field, nested objects are merged, lists are replaced."
input UpdateCharacterInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  appearance: AppearanceInput
  outfit: String
  personality: String
  defaultAccessoryIds: [ID!]
}

input CreateStyleInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  medium: String
  palette: [String!]
  lineWork: String
  shading: String
  lighting: String
  texture: String
  mood: String
  negative: [String!]
  allowText: Boolean
  generation: GenerationSettingsInput
}

input UpdateStyleInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  medium: String
  palette: [String!]
  lineWork: String
  shading: String
  lighting: String
  texture: String
  mood: String
  negative: [String!]
  allowText: Boolean
  generation: GenerationSettingsInput
}

input CreateLocationInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  setting: String
  era: String
  defaultTimeOfDay: String
  defaultWeather: String
  keyFeatures: [String!]
  palette: [String!]
}

input UpdateLocationInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  setting: String
  era: String
  defaultTimeOfDay: String
  defaultWeather: String
  keyFeatures: [String!]
  palette: [String!]
}

input CreateAccessoryInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  category: String
  material: String
  colors: [String!]
  size: String
  ownerCharacterId: ID
}

input UpdateAccessoryInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  category: String
  material: String
  colors: [String!]
  size: String
  ownerCharacterId: ID
}

input CreateSceneInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  "Joining a story appends the scene to story.sceneOrder."
  storyId: ID
  styleId: ID
  locationId: ID
  cast: [CastMemberInput!]
  accessoryIds: [ID!]
  camera: CameraInput
  timeOfDay: String
  weather: String
  lighting: String
  mood: String
  narrative: String
  negative: [String!]
  generation: GenerationSettingsInput
  referenceSelections: [ReferenceSelectionInput!]
  continuity: ContinuityInput
}

input UpdateSceneInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  storyId: ID
  styleId: ID
  locationId: ID
  cast: [CastMemberInput!]
  accessoryIds: [ID!]
  camera: CameraInput
  timeOfDay: String
  weather: String
  lighting: String
  mood: String
  narrative: String
  negative: [String!]
  generation: GenerationSettingsInput
  referenceSelections: [ReferenceSelectionInput!]
  continuity: ContinuityInput
}

input CreateStoryInput {
  id: ID
  name: String!
  description: String
  tags: [String!]
  promptHint: String
  synopsis: String
  audience: String
  styleId: ID
  generation: GenerationSettingsInput
}

input UpdateStoryInput {
  name: String
  description: String
  tags: [String!]
  promptHint: String
  synopsis: String
  audience: String
  styleId: ID
  "Reorders the story's scenes. Only scenes belonging to the story are allowed."
  sceneOrder: [ID!]
  generation: GenerationSettingsInput
}

"Exactly one source must be given. url works only if the server allows it."
input ImageInput {
  base64: String
  dataUri: String
  url: String
}

input AddReferenceImageInput {
  kind: EntityKind!
  entityId: ID!
  image: ImageInput!
  label: String
  view: String
  notes: String
  "Defaults to true for the entity's first reference."
  isPrimary: Boolean
}

input UpdateReferenceImageInput {
  kind: EntityKind!
  entityId: ID!
  referenceId: ID!
  label: String
  view: String
  notes: String
  isPrimary: Boolean
}

input ReferenceBudgetInput {
  maxReferences: Int
  maxPerEntity: Int
}

input ResizeInput {
  width: Int!
  height: Int!
  fit: ResizeFit
  kernel: ResizeKernel
}

input PostProcessInput {
  removeBackground: Boolean
  autoCrop: Boolean
  autoCropPaddingPercent: Float
  resize: ResizeInput
}

input ComposeOptionsInput {
  generation: GenerationSettingsInput
  extraInstructions: String
  referenceBudget: ReferenceBudgetInput
  "Entity previews only: style to render in (a story uses its own style by default)."
  styleId: ID
  "Entity previews only: replaces the default framing sentence."
  framing: String
}

input RenderOptionsInput {
  "Number of candidate images (1-4)."
  count: Int
  generation: GenerationSettingsInput
  extraInstructions: String
  referenceBudget: ReferenceBudgetInput
  postProcess: PostProcessInput
  "Entity previews only."
  styleId: ID
  "Entity previews only."
  framing: String
}

input RefineInput {
  "What to change, e.g. 'make Ala smile'. Everything else is kept."
  instructions: String!
  count: Int
  generation: GenerationSettingsInput
  referenceBudget: ReferenceBudgetInput
  postProcess: PostProcessInput
}

input UpscaleInput {
  "Default 2."
  scale: Float
  endpoint: String
  postProcess: PostProcessInput
}

input PromoteRenderInput {
  renderId: ID!
  kind: EntityKind!
  entityId: ID!
  label: String
  view: String
  notes: String
  isPrimary: Boolean
}

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

type Query {
  entity(kind: EntityKind!, id: ID!): Entity

  character(id: ID!): Character
  characters(tag: String, first: Int = 50, after: String): CharacterPage!
  style(id: ID!): Style
  styles(tag: String, first: Int = 50, after: String): StylePage!
  location(id: ID!): Location
  locations(tag: String, first: Int = 50, after: String): LocationPage!
  accessory(id: ID!): Accessory
  accessories(tag: String, first: Int = 50, after: String): AccessoryPage!
  scene(id: ID!): Scene
  scenes(storyId: ID, tag: String, first: Int = 50, after: String): ScenePage!
  story(id: ID!): Story
  stories(tag: String, first: Int = 50, after: String): StoryPage!

  "A pending render is refreshed from the provider unless sync is false."
  render(id: ID!, sync: Boolean = true): Render
  "Newest first."
  renders(targetKind: EntityKind, targetId: ID, status: RenderStatus, first: Int = 20, after: String): RenderPage!

  "Dry run of renderScene."
  composeScenePrompt(sceneId: ID!, options: ComposeOptionsInput): ComposedPrompt!
  "Dry run of renderEntityPreview."
  composeEntityPreviewPrompt(kind: EntityKind!, id: ID!, options: ComposeOptionsInput): ComposedPrompt!

  "Tool definitions (JSON) for an LLM agent that drives this API."
  toolDefinitions(format: ToolFormat = ANTHROPIC): String!
}

type Mutation {
  createCharacter(input: CreateCharacterInput!): Character!
  "expectedVersion: fail with CONFLICT if someone else changed it meanwhile."
  updateCharacter(id: ID!, input: UpdateCharacterInput!, expectedVersion: Int): Character!
  "force: detach from scenes/accessories that reference it instead of failing."
  deleteCharacter(id: ID!, force: Boolean = false): Boolean!

  createStyle(input: CreateStyleInput!): Style!
  updateStyle(id: ID!, input: UpdateStyleInput!, expectedVersion: Int): Style!
  deleteStyle(id: ID!, force: Boolean = false): Boolean!

  createLocation(input: CreateLocationInput!): Location!
  updateLocation(id: ID!, input: UpdateLocationInput!, expectedVersion: Int): Location!
  deleteLocation(id: ID!, force: Boolean = false): Boolean!

  createAccessory(input: CreateAccessoryInput!): Accessory!
  updateAccessory(id: ID!, input: UpdateAccessoryInput!, expectedVersion: Int): Accessory!
  deleteAccessory(id: ID!, force: Boolean = false): Boolean!

  createScene(input: CreateSceneInput!): Scene!
  updateScene(id: ID!, input: UpdateSceneInput!, expectedVersion: Int): Scene!
  deleteScene(id: ID!, force: Boolean = false): Boolean!

  createStory(input: CreateStoryInput!): Story!
  updateStory(id: ID!, input: UpdateStoryInput!, expectedVersion: Int): Story!
  deleteStory(id: ID!, force: Boolean = false): Boolean!

  addReferenceImage(input: AddReferenceImageInput!): ReferenceImage!
  updateReferenceImage(input: UpdateReferenceImageInput!): ReferenceImage!
  removeReferenceImage(kind: EntityKind!, entityId: ID!, referenceId: ID!): Boolean!

  """
  Queues an illustration of the scene with its cast, accessories, location, style and
  continuity anchors. Returns immediately with renders in status QUEUED; poll render(id)
  or wait for the server's webhook. The first successful render becomes the scene's
  selected one if none is selected.
  """
  renderScene(sceneId: ID!, options: RenderOptionsInput): [Render!]!
  "Queues a character design, object, location shot, style sample or story cover."
  renderEntityPreview(kind: EntityKind!, id: ID!, options: RenderOptionsInput): [Render!]!
  "Edits a finished render according to instructions, keeping everything else."
  refineRender(renderId: ID!, input: RefineInput!): [Render!]!
  "Enlarges a finished render (e.g. for print)."
  upscaleRender(renderId: ID!, input: UpscaleInput): Render!
  "Refreshes a pending render from the provider."
  syncRender(id: ID!): Render!
  "Refreshes all pending renders (for schedulers)."
  syncPendingRenders(limit: Int = 50): SyncResult!
  cancelRender(id: ID!): Render!
  "Runs the configured reviewer (moderation + consistency) again."
  reviewRender(id: ID!): Render!
  "null clears the selection."
  selectSceneRender(sceneId: ID!, renderId: ID): Scene!
  deleteRender(id: ID!): Boolean!
  "Copies a render's image into an entity's reference images."
  promoteRenderToReference(input: PromoteRenderInput!): ReferenceImage!
}
`;
