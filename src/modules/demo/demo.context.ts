import { AsyncLocalStorage } from "node:async_hooks";

// Set for the whole request when the logged-in user is the shared demo admin.
export const demoStore = new AsyncLocalStorage<{ demo: true }>();

export const isDemoAdmin = (email?: string, role?: string) =>
    (!!email && email.toLowerCase() === (process.env.DEMO_ADMIN_EMAIL || "demoadmin@gmail.com").toLowerCase()) ||
    (!!role && role.toLowerCase() === "demoadmin");

export const inDemoRequest = () => !!demoStore.getStore()?.demo;