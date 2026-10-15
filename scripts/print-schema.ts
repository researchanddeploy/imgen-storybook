import { writeFileSync } from "node:fs";
import { typeDefs } from "../src/graphql/typeDefs.js";

// Writes the SDL to schema.graphql so client apps can run codegen against it.
writeFileSync(new URL("../schema.graphql", import.meta.url), `${typeDefs.trim()}\n`);
console.log("schema.graphql written");
