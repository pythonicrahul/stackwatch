import * as core from '@actions/core';
import { run } from './run';

run().catch((error: unknown) => {
  core.setFailed(`stackwatch: unexpected error: ${(error as Error).message}`);
});
