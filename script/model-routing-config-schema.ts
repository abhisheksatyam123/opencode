#!/usr/bin/env bun

import path from "path"
import fs from "fs/promises"
import { Config } from "../src/config/config"

const out = process.argv[2] ?? path.join(process.cwd(), "schema", "model-routing-config.schema.json")
const schema = Config.generateModelRoutingConfigContractJsonSchema()

await fs.mkdir(path.dirname(out), { recursive: true })
await Bun.write(out, JSON.stringify(schema, null, 2) + "\n")
console.log(out)
