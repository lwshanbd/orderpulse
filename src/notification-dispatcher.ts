import type { OrderPulseDatabase } from "./database.js";
import type { NotificationJob, PushMessage, PushResult, PushSender } from "./mobile-types.js";
import type { OrderEvent } from "./order-types.js";

function notificationText(event: OrderEvent): { title: string; body: string } {
  if (event.type === "order_inactive") {
    return { title: "订单列表有变化", body: "Tesla 暂时不再返回这笔活跃订单，请打开 OrderPulse 查看。" };
  }
  if (event.type === "order_reappeared") {
    return { title: "订单重新出现", body: "这笔订单已重新出现在 Tesla 活跃订单中。" };
  }
  if (event.type === "configuration_changed" && event.notificationEligible) {
    const current = event.currentSubstatus;
    const previous = event.previousSubstatus;
    if (current && previous && current !== previous) {
      return { title: "Tesla 交付信息更新", body: `${previous} → ${current}` };
    }
    return { title: "Tesla 交付信息更新", body: current ?? "交付详情发生了变化。" };
  }
  const current = event.currentSubstatus ?? event.currentStatus;
  const previous = event.previousSubstatus ?? event.previousStatus;
  if (current && previous) {
    return { title: "Tesla 订单状态更新", body: `${previous} → ${current}` };
  }
  if (current) {
    return { title: "Tesla 订单状态更新", body: `当前状态：${current}` };
  }
  return { title: "Tesla 订单状态更新", body: "订单信息发生了变化。" };
}

function messageForJob(job: NotificationJob): PushMessage {
  const text = notificationText(job.event);
  return {
    deviceToken: job.deviceToken,
    environment: job.environment,
    title: text.title,
    body: text.body,
    eventId: job.event.id,
    eventType: job.event.type,
  };
}

export class NotificationDispatcher {
  readonly #database: OrderPulseDatabase;
  readonly #sender: PushSender | null;
  #inFlight: Promise<number> | null = null;

  constructor(database: OrderPulseDatabase, sender: PushSender | null) {
    this.#database = database;
    this.#sender = sender;
  }

  get enabled(): boolean {
    return this.#sender !== null;
  }

  deliverPending(): Promise<number> {
    if (this.#inFlight) return this.#inFlight;
    const task = this.#deliverPending().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = task;
    return task;
  }

  async #deliverPending(): Promise<number> {
    if (!this.#sender) return 0;
    let acceptedCount = 0;
    for (const job of this.#database.listPendingNotificationJobs()) {
      let result: PushResult;
      try {
        result = await this.#sender.send(messageForJob(job));
      } catch {
        result = {
          accepted: false,
          errorCode: "notification_sender_error",
          permanentFailure: false,
        };
      }
      this.#database.recordNotificationDelivery({
        eventId: job.event.id,
        deviceId: job.deviceId,
        ...result,
      });
      if (result.accepted) acceptedCount += 1;
    }
    return acceptedCount;
  }

  async sendTest(deviceId: string): Promise<PushResult | null> {
    if (!this.#sender) return null;
    const target = this.#database.mobileDeviceNotificationTarget(deviceId);
    if (!target) return null;
    const result = await this.#sender.send({
      deviceToken: target.deviceToken,
      environment: target.environment,
      title: "OrderPulse 提醒已连接",
      body: "这是一条来自你的 NAS 的测试通知。",
      eventId: 0,
      eventType: "test",
    });
    if (result.permanentFailure) this.#database.removeMobilePushToken(deviceId);
    return result;
  }
}
