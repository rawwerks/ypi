#!/usr/bin/env node

import { runRecursiveChildLaunchGateCli } from "../extensions/ypi/internal/launch-gate.ts";

process.exitCode = await runRecursiveChildLaunchGateCli(process.argv.slice(2));
