import { User } from "../user/user.model";
import { getMailIdentity } from "../site-settings/site-settings.service";
import { sendMail } from "../../utils/mailer";
import { deliveryUpdateEmail, MailBrand } from "../../utils/emailTemplates";
import { notifyUser, PersonalActivityType } from "./activity.service";

/**
 * Every customer- and rider-facing notification, in one place.
 *
 * Two channels, one call site: the in-app line is written first, then the email
 * is attempted. Both swallow their own errors, so a mail server problem can
 * never undo an order or a delivery.
 */

/** "#ORD-A1B2C3", the short form every screen shows. */
export function shortOrderNumber(id: unknown): string {
  return `#ORD-${String(id).slice(-6).toUpperCase()}`;
}

function money(amount?: number): string {
  return typeof amount === "number" ? `$${amount.toFixed(2)}` : "";
}

async function recipientOf(userId: string) {
  try {
    const user: any = await User.findById(userId).select("name email").lean();
    return { name: user?.name as string | undefined, email: user?.email as string | undefined };
  } catch {
    return { name: undefined, email: undefined };
  }
}

/** Sends one delivery-lifecycle email, and never throws. */
async function sendUpdateEmail(params: {
  to?: string;
  recipientName?: string;
  heading: string;
  intro?: string;
  orderNumber?: string;
  rows?: { label: string; value?: string | number | null }[];
  note?: string;
  actionLabel?: string;
  actionPath?: string;
  brand: MailBrand;
}) {
  if (!params.to) return;
  try {
    const base = (params.brand.siteUrl || "").replace(/\/+$/, "");
    const { subject, html } = deliveryUpdateEmail({
      brand: params.brand,
      recipientName: params.recipientName,
      heading: params.heading,
      intro: params.intro,
      orderNumber: params.orderNumber,
      rows: params.rows,
      note: params.note,
      actionLabel: params.actionLabel,
      actionHref: base && params.actionPath ? `${base}${params.actionPath}` : undefined,
    });
    await sendMail({ to: params.to, subject, html });
  } catch (err) {
    console.error("[activity] Update email failed:", (err as Error).message);
  }
}

/** Wording for each order stage, so both channels say the same thing. */
const ORDER_STATUS_COPY: Record<
  string,
  {
    type: PersonalActivityType;
    title: string;
    heading: string;
    intro: string;
    email: boolean;
  }
> = {
  confirmed: {
    type: "order_confirmed",
    title: "Order confirmed",
    heading: "We received your order",
    intro: "The store has your order and will start preparing it.",
    email: false,
  },
  processing: {
    type: "order_processing",
    title: "Order is being prepared",
    heading: "Your order is being prepared",
    intro: "The store is packing your items.",
    email: false,
  },
  shipped: {
    type: "order_shipped",
    title: "Order shipped",
    heading: "Your order is on the way",
    intro: "A rider has been assigned and your parcel left the store.",
    email: true,
  },
  delivered: {
    type: "order_delivered",
    title: "Order delivered",
    heading: "Your order has been delivered",
    intro: "Thanks for shopping with us. We hope the item serves you well.",
    email: true,
  },
  cancelled: {
    type: "order_cancelled",
    title: "Order cancelled",
    heading: "Your order was cancelled",
    intro: "The items were returned to stock. If you paid online, the payment is marked failed.",
    email: true,
  },
};

/** A new order: in-app line plus the confirmation email. */
export async function notifyOrderPlaced(order: any) {
  try {
    const ref = String(order._id);
    const orderNumber = shortOrderNumber(order._id);
    const units = (order.items || []).reduce(
      (sum: number, item: any) => sum + (item.quantity || 0),
      0
    );

    await notifyUser({
      userId: String(order.userId),
      role: "customer",
      type: "order_placed",
      title: `Order ${orderNumber} confirmed`,
      detail: `${units} item${units === 1 ? "" : "s"} · ${money(order.totalAmount)}`,
      ref,
    });

    const { brand } = await getMailIdentity();
    const { name, email } = await recipientOf(String(order.userId));

    await sendUpdateEmail({
      to: email,
      recipientName: name,
      heading: "Your order is confirmed",
      intro: "We received your order and will let you know as soon as it ships.",
      orderNumber,
      rows: [
        { label: "Items", value: `${units} item${units === 1 ? "" : "s"}` },
        { label: "Total", value: money(order.totalAmount) },
        { label: "Payment", value: (order.paymentMethod || "").toUpperCase() },
      ],
      actionLabel: "View your orders",
      actionPath: "/dashboard/customer/orders",
      brand,
    });
  } catch (err) {
    console.error("[activity] Order placed notification failed:", (err as Error).message);
  }
}

/**
 * An order stage changed. Every stage gets an in-app line; only the stages a
 * customer acts on (shipped, delivered, cancelled) also send email.
 */
export async function notifyOrderStatusChanged(order: any, status: string, note?: string) {
  try {
    const copy = ORDER_STATUS_COPY[status];
    if (!copy) return;

    const ref = String(order._id);
    const orderNumber = shortOrderNumber(order._id);

    await notifyUser({
      userId: String(order.userId),
      role: "customer",
      type: copy.type,
      title: `${copy.title} ${orderNumber}`,
      detail: note || copy.intro,
      ref,
    });

    if (!copy.email) return;

    const { brand } = await getMailIdentity();
    const { name, email } = await recipientOf(String(order.userId));

    await sendUpdateEmail({
      to: email,
      recipientName: name,
      heading: copy.heading,
      intro: copy.intro,
      orderNumber,
      rows: [
        { label: "Items", value: `${(order.items || []).length} product line(s)` },
        { label: "Total", value: money(order.totalAmount) },
      ],
      note,
      // A shipped order always has a rider on it, so the email points at the
      // live tracking page rather than the orders list. Earlier and later
      // stages have no map to open, so they keep the orders page.
      actionLabel: status === "shipped" ? "Track your delivery" : "View your orders",
      actionPath: status === "shipped" ? `/track-order/${ref}` : "/dashboard/customer/orders",
      brand,
    });
  } catch (err) {
    console.error("[activity] Order status notification failed:", (err as Error).message);
  }
}

/** Everything a rider needs to accept or decline a request. */
export interface RiderAssignmentInfo {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  customerName?: string;
  customerPhone?: string;
  address?: string;
  items?: number;
  total?: number;
  fee?: number;
  expiresAt?: Date;
}

/** A new request in the rider's dashboard, plus the email that reaches them. */
export async function notifyRiderAssigned(riderId: string, info: RiderAssignmentInfo) {
  try {
    await notifyUser({
      userId: riderId,
      role: "rider",
      type: "delivery_assigned",
      title: `New delivery request ${info.orderNumber}`,
      detail: [info.customerName, info.address, money(info.fee)].filter(Boolean).join(" · "),
      ref: info.deliveryId,
    });

    const { brand } = await getMailIdentity();
    const { name, email } = await recipientOf(riderId);

    await sendUpdateEmail({
      to: email,
      recipientName: name,
      heading: "New delivery request",
      intro: "Open your dashboard to accept or decline this delivery.",
      orderNumber: info.orderNumber,
      rows: [
        { label: "Customer", value: info.customerName },
        { label: "Phone", value: info.customerPhone },
        { label: "Address", value: info.address },
        { label: "Items", value: info.items },
        { label: "Delivery fee", value: money(info.fee) },
        { label: "Respond before", value: info.expiresAt?.toISOString() },
      ],
      actionLabel: "Open delivery requests",
      actionPath: "/dashboard/rider/requests",
      brand,
    });
  } catch (err) {
    console.error("[activity] Rider assignment notification failed:", (err as Error).message);
  }
}

/** A customer-facing delivery event: out for delivery, delivered, cancelled. */
export async function notifyCustomerDelivery(params: {
  userId: string;
  deliveryId: string;
  /**
   * The order behind the delivery. When it is given the line opens the live
   * tracking page, which is the only screen that shows the rider's position and
   * the code to read at the door.
   */
  orderId?: string;
  orderNumber: string;
  title: string;
  detail?: string;
  emailHeading?: string;
  emailRows?: { label: string; value?: string | number | null }[];
}) {
  try {
    await notifyUser({
      userId: params.userId,
      role: "customer",
      type: "delivery_update",
      title: `${params.title} ${params.orderNumber}`,
      detail: params.detail || "",
      ref: params.orderId || params.deliveryId,
    });

    if (!params.emailHeading) return;
    const { brand } = await getMailIdentity();
    const { name, email } = await recipientOf(params.userId);

    await sendUpdateEmail({
      to: email,
      recipientName: name,
      heading: params.emailHeading,
      intro: params.detail,
      orderNumber: params.orderNumber,
      rows: params.emailRows,
      actionLabel: params.orderId ? "Track your delivery" : "View your orders",
      actionPath: params.orderId
        ? `/track-order/${params.orderId}`
        : "/dashboard/customer/orders",
      brand,
    });
  } catch (err) {
    console.error("[activity] Customer delivery notification failed:", (err as Error).message);
  }
}

/**
 * Tells the store inbox about a delivery problem, such as a decline — or about
 * an order a seller accepted, which is the store's cue to put a rider on it.
 */
export async function notifyAdminDeliveryEmail(params: {
  heading: string;
  intro?: string;
  orderNumber?: string;
  rows?: { label: string; value?: string | number | null }[];
  note?: string;
  /** Where the email sends the store, when the board it should open differs. */
  actionLabel?: string;
  actionPath?: string;
}) {
  try {
    const { supportInbox, brand } = await getMailIdentity();
    if (!supportInbox) return;

    await sendUpdateEmail({
      to: supportInbox,
      heading: params.heading,
      intro: params.intro,
      orderNumber: params.orderNumber,
      rows: params.rows,
      note: params.note,
      actionLabel: params.actionLabel || "Open deliveries",
      actionPath: params.actionPath || "/dashboard/admin/deliveries",
      brand,
    });
  } catch (err) {
    console.error("[activity] Admin delivery email failed:", (err as Error).message);
  }
}
