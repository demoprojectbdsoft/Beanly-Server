import { Request } from "express";
import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ApiError } from "../../utils/apiError";
import { isAdminRole } from "../../utils/roles";
import { parseQuery } from "../../utils/validate";
import * as productService from "./product.service";
import { ProductView } from "./product.service";
import { getProductsQuerySchema } from "./product.validator";

/**
 * Which shape the caller is owed.
 *
 * `mode=admin` asks for the desk view: cost, margin, the stored prices and the
 * rows a shopper cannot reach. Anyone else asking for it is told no rather than
 * quietly downgraded, so a broken desk call cannot pass for a working one.
 */
function resolveProductView(req: Request, mode?: string): ProductView {
  if (mode !== "admin") return "public";
  if (!isAdminRole(req.user?.role)) throw new ApiError(403, "Admin privileges required");
  return "admin";
}

export const createProduct = catchAsync(async (req, res) => {
  const product = await productService.createProduct(req.body);
  apiResponse(res, 201, product, "Product created");
});

export const getProducts = catchAsync(async (req, res) => {
  const query = parseQuery(getProductsQuerySchema, req.query);
  const view = resolveProductView(req, query.mode);
  const result = await productService.getProducts(query, view);
  apiResponse(res, 200, result, "Products fetched successfully");
});

export const getProductBySlug = catchAsync(async (req, res) => {
  const view = resolveProductView(req, req.query.mode as string | undefined);
  const product = await productService.getProductBySlug(req.params.slug as string, view);
  apiResponse(res, 200, product, "Product fetched successfully");
});

export const updateProduct = catchAsync(async (req, res) => {
  const product = await productService.updateProduct(req.params.id as string, req.body);
  apiResponse(res, 200, product, "Product updated");
});

export const deleteProduct = catchAsync(async (req, res) => {
  await productService.deleteProduct(req.params.id as string);
  apiResponse(res, 200, null, "Product deleted");
});