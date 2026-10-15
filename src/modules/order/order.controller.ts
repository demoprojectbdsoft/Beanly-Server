import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ApiError } from "../../utils/apiError";
import * as orderService from "./order.service";
import { getOrdersQuerySchema } from "./order.validator";

export const createOrder = catchAsync(async (req, res) => {
  const order = await orderService.createOrder(req.body);
  apiResponse(res, 201, order, "Order placed successfully");
});

export const getOrders = catchAsync(async (req, res, next) => {
  const parsed = getOrdersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }
  const result = await orderService.getOrders(parsed.data);
  apiResponse(res, 200, result, "Orders fetched successfully");
});

export const getOrderById = catchAsync(async (req, res) => {
  const order = await orderService.getOrderById(req.params.id as string);
  apiResponse(res, 200, order);
});

export const updateOrderStatus = catchAsync(async (req, res) => {
  const order = await orderService.updateOrderStatus(req.params.id as string, req.body);
  apiResponse(res, 200, order, "Order status updated");
});

export const updateCustomerResponse = catchAsync(async (req, res) => {
  const userId = req.user?.id;
  const userRole = req.user?.role;
  const order = await orderService.updateCustomerResponse(
    req.params.id as string,
    req.body,
    userId,
    userRole
  );
  apiResponse(res, 200, order, "Customer response updated successfully");
});