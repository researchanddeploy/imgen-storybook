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
  SUCCEEDED
  FAILED
}

enum RenderMode {
  "No reference images — plain text-to-image."
  TEXT_TO_IMAGE
  "Reference images attached — image-conditioned generation."
  REFERENCE_TO_IMAGE
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

# ---------------------------------------------------------------------------
# Output types
# ---------------------------------------------------------------------------

"""
A stored image (reference or render).
"""
type StoredImage {
  key: String!
  mimeType: String!
  "Public URL, when the storage adapter exposes one."
  url: String
  "Inline data: URI. Heavy — request only when no url is available."
  dataUri: String
  width: Int
  height: Int
}

"""
A user-provided image that defines how an entity looks. References are the source of
visual consistency: they are attached to every render that features the entity.
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
  image: StoredImage!
  createdAt: String!
}

interface Entity {
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  "Extra text appended whenever the entity is described in a prompt."
  promptHint: String
  references: [ReferenceImage!]!
  "Renders whose target is this entity, newest first."
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!
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
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

  appearance: Appearance!
  outfit: String
  personality: String
  defaultAccessoryIds: [ID!]!
  defaultAccessories: [Accessory!]!
}

type Style implements Entity {
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

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
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

  setting: String
  era: String
  defaultTimeOfDay: String
  defaultWeather: String
  keyFeatures: [String!]!
  palette: [String!]!
}

type Accessory implements Entity {
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

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
}

type Camera {
  shot: String
  angle: String
  lens: String
  composition: String
}

type Scene implements Entity {
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

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
  selectedRenderId: ID
  selectedRender: Render
}

type Story implements Entity {
  id: ID!
  kind: EntityKind!
  name: String!
  description: String!
  tags: [String!]!
  promptHint: String
  references: [ReferenceImage!]!
  renders: [Render!]!
  createdAt: String!
  updatedAt: String!

  synopsis: String
  audience: String
  styleId: ID
  style: Style
  sceneOrder: [ID!]!
  "Scenes in display order."
  scenes: [Scene!]!
  generation: GenerationSettings!
}

type RenderTarget {
  kind: EntityKind!
  id: ID!
  entity: Entity
}

type RenderReference {
  "1-based position in the image list sent to the model."
  index: Int!
  entityKind: EntityKind!
  entityId: ID!
  referenceId: ID!
  label: String
}

type RenderParams {
  aspectRatio: String!
  resolution: String!
  outputFormat: OutputFormat!
}

type Render {
  id: ID!
  target: RenderTarget!
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
  createdAt: String!
}

type PlannedReference {
  index: Int!
  entityKind: EntityKind!
  entityId: ID!
  entityName: String!
  referenceId: ID!
  label: String
  view: String
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
  characters(tag: String): [Character!]!
  style(id: ID!): Style
  styles(tag: String): [Style!]!
  location(id: ID!): Location
  locations(tag: String): [Location!]!
  accessory(id: ID!): Accessory
  accessories(tag: String): [Accessory!]!
  scene(id: ID!): Scene
  scenes(storyId: ID, tag: String): [Scene!]!
  story(id: ID!): Story
  stories(tag: String): [Story!]!

  render(id: ID!): Render
  renders(targetKind: EntityKind, targetId: ID): [Render!]!

  "Dry run of renderScene."
  composeScenePrompt(sceneId: ID!, options: ComposeOptionsInput): ComposedPrompt!
  "Dry run of renderEntityPreview."
  composeEntityPreviewPrompt(kind: EntityKind!, id: ID!, options: ComposeOptionsInput): ComposedPrompt!
}

type Mutation {
  createCharacter(input: CreateCharacterInput!): Character!
  updateCharacter(id: ID!, input: UpdateCharacterInput!): Character!
  "force: detach from scenes/accessories that reference it instead of failing."
  deleteCharacter(id: ID!, force: Boolean = false): Boolean!

  createStyle(input: CreateStyleInput!): Style!
  updateStyle(id: ID!, input: UpdateStyleInput!): Style!
  deleteStyle(id: ID!, force: Boolean = false): Boolean!

  createLocation(input: CreateLocationInput!): Location!
  updateLocation(id: ID!, input: UpdateLocationInput!): Location!
  deleteLocation(id: ID!, force: Boolean = false): Boolean!

  createAccessory(input: CreateAccessoryInput!): Accessory!
  updateAccessory(id: ID!, input: UpdateAccessoryInput!): Accessory!
  deleteAccessory(id: ID!, force: Boolean = false): Boolean!

  createScene(input: CreateSceneInput!): Scene!
  updateScene(id: ID!, input: UpdateSceneInput!): Scene!
  deleteScene(id: ID!, force: Boolean = false): Boolean!

  createStory(input: CreateStoryInput!): Story!
  updateStory(id: ID!, input: UpdateStoryInput!): Story!
  deleteStory(id: ID!, force: Boolean = false): Boolean!

  addReferenceImage(input: AddReferenceImageInput!): ReferenceImage!
  updateReferenceImage(input: UpdateReferenceImageInput!): ReferenceImage!
  removeReferenceImage(kind: EntityKind!, entityId: ID!, referenceId: ID!): Boolean!

  """
  Renders the scene with its cast, accessories, location and style, attaching their
  reference images. Failed generations come back as renders with status FAILED.
  The first successful render becomes the scene's selected one if none is selected.
  """
  renderScene(sceneId: ID!, options: RenderOptionsInput): [Render!]!
  """
  Renders a stand-alone image of an entity: a character design, an object, a location
  establishing shot, a style sample or a story cover.
  """
  renderEntityPreview(kind: EntityKind!, id: ID!, options: RenderOptionsInput): [Render!]!
  "null clears the selection."
  selectSceneRender(sceneId: ID!, renderId: ID): Scene!
  deleteRender(id: ID!): Boolean!
  "Copies a render's image into an entity's reference images."
  promoteRenderToReference(input: PromoteRenderInput!): ReferenceImage!
}
`;
