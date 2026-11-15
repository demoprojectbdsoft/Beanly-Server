import { Router } from "express";
import * as controller from "./file.controller";
import { requireInternalKey } from "../../middlewares/internal.middleware";

const router = Router();

/**
 * Application documents: a licence, vehicle papers, a trade certificate.
 *
 * Only the storefront may store one — it holds the internal key, and it is the
 * only thing that has already checked that the person uploading is signed in.
 * Reading is open, because a preview in a browser is a plain request with no
 * header to attach a key to.
 */

// The filename is part of the path so the browser can see the extension.
router.get("/:id/:name?", controller.getFile);

router.post("/", requireInternalKey, controller.uploadFile);

export default router;
