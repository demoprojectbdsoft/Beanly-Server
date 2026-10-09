import { User } from "./user.model";
import { ApiError } from "../../utils/apiError";
import { UpdateUserInput, GetUsersQuery } from "./user.validator";
import { getMembershipTier } from "../order/order.service";

export async function getUsers(query: GetUsersQuery) {
  const { role, status, search, page, limit } = query;

  const filter: Record<string, any> = {};
  if (role) filter.role = role;
  if (status) filter.status = status;
  // Optional search across name and email fields (case-insensitive)
  if (search?.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    filter.$or = [{ name: searchRegex }, { email: searchRegex }];
  }

  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getUserById(id: string) {
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

export async function updateUser(id: string, data: UpdateUserInput) {
  if (data.points !== undefined && data.member === undefined) {
    data.member = getMembershipTier(data.points);
  }
  const user = await User.findByIdAndUpdate(id, data, { new: true });
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

export async function deleteUser(id: string) {
  const user = await User.findByIdAndDelete(id);
  if (!user) throw new ApiError(404, "User not found");
}