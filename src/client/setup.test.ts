/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
export const modules = import.meta.glob("./**/*.*s");

import {
  defineSchema,
  type GenericSchema,
  type SchemaDefinition,
} from "convex/server";
import { type ComponentApi } from "../component/_generated/component.js";
import { componentsGeneric } from "convex/server";
import componentSchema from "../component/schema.js";
export { componentSchema };
export const componentModules = import.meta.glob("../component/**/*.ts");
import workpool from "@convex-dev/workpool/test";

export function initConvexTest<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(schema?: Schema) {
  const t = convexTest(schema ?? defineSchema({}), modules);
  t.registerComponent("workpool", workpool.schema, workpool.modules);
  t.registerComponent("rag", componentSchema, componentModules);
  return t;
}
export const components = componentsGeneric() as unknown as {
  rag: ComponentApi;
};

test("setup", () => {});
