import { defineApp } from "convex/server";
import rag from "string-rag/convex.config";

const app = defineApp();
app.use(rag);

export default app;
