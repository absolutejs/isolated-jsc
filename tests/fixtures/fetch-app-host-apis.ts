// Imports an isolate cannot provide, for bundleFetchHandler's Web-only check.
import { readFileSync } from "node:fs";
import { join } from "path";
import { serve } from "bun";

export default {
  fetch: () =>
    new Response(String([typeof readFileSync, join("a", "b"), typeof serve])),
};
