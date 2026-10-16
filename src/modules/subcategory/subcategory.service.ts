import { Types } from "mongoose";
import { SubCategory } from "./subcategory.model";
import { Category } from "../category/category.model";
import { Product } from "../product/product.model";
import { ApiError } from "../../utils/apiError";
import { CreateSubCategoryInput, UpdateSubCategoryInput } from "./subcategory.validator";

export async function createSubCategory(data: CreateSubCategoryInput) {
  // Ensure parent category exists before creating the subcategory
  const parent = await Category.findById(data.categoryId);
  if (!parent) throw new ApiError(404, "Parent category not found");

  const existing = await SubCategory.findOne({ slug: data.slug });
  if (existing) throw new ApiError(409, "Slug already in use");

  return SubCategory.create(data);
}

export async function getSubCategories(categoryId?: string) {
  const filter = categoryId ? { categoryId } : {};
  return SubCategory.find(filter).sort({ createdAt: -1 });
}

export async function updateSubCategory(id: string, data: UpdateSubCategoryInput) {
  const subCategory = await SubCategory.findByIdAndUpdate(id, data, { new: true });
  if (!subCategory) throw new ApiError(404, "Subcategory not found");
  return subCategory;
}

export async function deleteSubCategory(id: string) {
  // Block delete if any products are linked to this subcategory
  const idObj = Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
  const subMatches: any[] = idObj ? [id, idObj] : [id];

  const productCount = await Product.countDocuments({
    subCategoryIds: { $in: subMatches },
  });
  if (productCount > 0) throw new ApiError(400, "Cannot delete subcategory with active products");
  await SubCategory.findByIdAndDelete(id);
}