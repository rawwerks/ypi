#!/usr/bin/env node

import { runRecursiveChildLaunchGateCli } from "../extensions/ypi/internal/launch-gate.ts";

process.exitCode = runRecursiveChildLaunchGateCli(process.argv.slice(2));
