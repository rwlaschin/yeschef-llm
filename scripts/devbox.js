#!/usr/bin/env node
// The devbox CLI. Scripts live in scripts/; the fleet API it drives is dashboard code
// (dashboard/server/utils/devbox.js), because the dashboard's server routes import it.
import { runCli } from "../dashboard/server/utils/devbox.js";

await runCli();
