/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { moment } from "@webpack/common";
import * as DataStore from "@api/DataStore";

interface ScheduledMessage {
    channelId: string;
    content: string;
    scheduledTime: number;
    timeoutId: NodeJS.Timeout;
    interval?: number;
}

const settings = definePluginSettings({
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show notifications when scheduled messages are sent",
        default: true
    }
});

// Store for scheduled messages
const scheduledMessages: ScheduledMessage[] = [];
const logger = new Logger("MessageScheduler");

interface StoredRecurringMessage {
    channelId: string;
    content: string;
    interval: number;
    scheduledTime: number;
}

const STORAGE_KEY = "MessageScheduler_recurring_v1";

async function saveRecurringMessages() {
    const recurring = scheduledMessages
        .filter(msg => msg.interval !== undefined)
        .map(msg => ({
            channelId: msg.channelId,
            content: msg.content,
            interval: msg.interval!,
            scheduledTime: msg.scheduledTime
        }));

    await DataStore.set(STORAGE_KEY, recurring);
}

async function restoreRecurringMessages() {
    const stored = await DataStore.get(STORAGE_KEY) as
        | StoredRecurringMessage[]
        | undefined;

    if (!Array.isArray(stored)) return;

    for (const msg of stored) {
        if (
            !msg.channelId ||
            typeof msg.content !== "string" ||
            !Number.isFinite(msg.interval) ||
            msg.interval <= 0 ||
            !Number.isFinite(msg.scheduledTime)
        ) continue;

        const delay = Math.max(0, msg.scheduledTime - Date.now());

        scheduleMessage(
            msg.channelId,
            msg.content,
            delay,
            msg.interval
        );
    }
}

// Parse relative time like "1h30m", "2d", "30s", etc.
function parseRelativeTime(timeStr: string): number | null {
    const regex = /(\d+)([dhms])/g;
    let match: RegExpExecArray | null;
    let totalMs = 0;
    let found = false;

    while ((match = regex.exec(timeStr)) !== null) {
        found = true;
        const value = parseInt(match[1], 10);
        const unit = match[2];

        switch (unit) {
            case "d":
                totalMs += value * 24 * 60 * 60 * 1000;
                break;
            case "h":
                totalMs += value * 60 * 60 * 1000;
                break;
            case "m":
                totalMs += value * 60 * 1000;
                break;
            case "s":
                totalMs += value * 1000;
                break;
        }
    }

    return found ? totalMs : null;
}

// Parse exact time like "3:30pm", "15:45", etc.
function parseExactTime(timeStr: string): number | null {
    // Try to parse various time formats
    const formats = [
        "h:mma", "h:mm a", "H:mm", // 3:30pm, 3:30 pm, 15:30
        "ha", "h a", "H", // 3pm, 3 pm, 15
    ];

    for (const format of formats) {
        const date = moment(timeStr, format);
        if (date.isValid()) {
            let timestamp = date.valueOf();

            // If the time is in the past, add a day
            if (timestamp < Date.now()) {
                timestamp += 24 * 60 * 60 * 1000;
            }

            return timestamp;
        }
    }

    return null;
}

function scheduleMessage(
    channelId: string,
    content: string,
    delay: number,
    interval?: number
): void {
    const scheduled: ScheduledMessage = {
        channelId,
        content,
        scheduledTime: Date.now() + delay,
        timeoutId: undefined as unknown as NodeJS.Timeout,
        interval
    };

    const scheduleNext = (nextDelay: number) => {
        scheduled.scheduledTime = Date.now() + nextDelay;

        scheduled.timeoutId = setTimeout(() => {
            try {
                sendMessage(channelId, { content });

                if (settings.store.showNotifications) {
                    Vencord.Webpack.Common.showToast({
                        variant: "success",
                        text: interval
                            ? "Recurring scheduled message sent!"
                            : "Scheduled message sent!"
                    });
                }
            } catch (error) {
                logger.error("Failed to send scheduled message", error);
            }

            if (scheduled.interval && scheduled.interval > 0) {
                scheduleNext(scheduled.interval);

                void saveRecurringMessages().catch(error =>
                    logger.error("Failed to update recurring messages", error)
                );
            } else {
                const index = scheduledMessages.indexOf(scheduled);
                if (index !== -1) {
                    scheduledMessages.splice(index, 1);
                }
            }
        }, nextDelay);
    };

    scheduledMessages.push(scheduled);

    if (interval !== undefined) {
        void saveRecurringMessages().catch(error =>
            logger.error("Failed to save recurring messages", error)
        );
    }

    scheduleNext(delay);

    if (settings.store.showNotifications) {
        Vencord.Webpack.Common.showToast({
            variant: "success",
            text: interval
                ? `Recurring message scheduled every ${moment.duration(interval).humanize()}`
                : `Message scheduled for ${moment(scheduled.scheduledTime).format("LT")}`
        });
    }
}


export default definePlugin({
    name: "MessageScheduler",
    description: "Schedule messages to be sent at a specific time or after a delay",
    authors: [{ name: "MessageScheduler", id: 0n }],
    settings,

    commands: [
        {
            name: "schedule",
            description: "Schedule a message to be sent later",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "message",
                    description: "The message to send",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "time",
                    description: "When to send the message (e.g. '1h30m', '3:30pm')",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute: (args, ctx) => {
                const message = args.find(arg => arg.name === "message")?.value as string;
                const timeStr = args.find(arg => arg.name === "time")?.value as string;

                if (!message || !timeStr) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide both a message and a time."
                    });
                    return;
                }

                // Try to parse as relative time first
                let delay = parseRelativeTime(timeStr);

                // If not a relative time, try as exact time
                if (delay === null) {
                    const exactTime = parseExactTime(timeStr);
                    if (exactTime !== null) {
                        delay = exactTime - Date.now();
                    } else {
                        sendBotMessage(ctx.channel.id, {
                            content: "❌ Invalid time format. Use relative time (e.g. '1h30m', '45s') or exact time (e.g. '3:30pm', '15:45')."
                        });
                        return;
                    }
                }

                if (delay <= 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ The scheduled time must be in the future."
                    });
                    return;
                }

                scheduleMessage(ctx.channel.id, message, delay);

                sendBotMessage(ctx.channel.id, {
                    content: `✅ Message scheduled to be sent ${moment().add(delay, "ms").fromNow()}.`
                });
            }
        },

        {
            name: "schedule-interval",
            description: "Schedule a message to repeat at regular intervals",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "message",
                    description: "The message to send repeatedly",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "interval",
                    description: "Time between messages (e.g. '30m', '2h', '1d')",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute: (args, ctx) => {
                const message = args.find(
                    arg => arg.name === "message"
                )?.value as string;

                const intervalStr = args.find(
                    arg => arg.name === "interval"
                )?.value as string;

                if (!message?.trim() || !intervalStr?.trim()) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide both a message and an interval."
                    });
                    return;
                }

                const interval = parseRelativeTime(intervalStr);

                if (
                    interval === null ||
                    interval <= 0 ||
                    !/^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/.test(intervalStr) ||
                    !/\d+[dhms]/.test(intervalStr)
                ) {
                    sendBotMessage(ctx.channel.id, {
                        content: "Invalid interval. Use formats like '30m', '2h', '1d', or '1h30m'."
                    });
                    return;
                }

                scheduleMessage(
                    ctx.channel.id,
                    message,
                    interval,
                    interval
                );

                sendBotMessage(ctx.channel.id, {
                    content: `Recurring message scheduled every ${intervalStr}. Use /scheduled to view it or /cancel-scheduled to cancel it.`
                });
            }
        },
        {
            name: "scheduled",
            description: "List all scheduled messages",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => {
                const channelMessages = scheduledMessages.filter(msg => msg.channelId === ctx.channel.id);

                if (channelMessages.length === 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "No scheduled messages for this channel."
                    });
                    return;
                }

                const messageList = channelMessages.map((msg, index) => {
                    const timeStr = moment(msg.scheduledTime).format("LT");
                    const preview = msg.content.length > 50
                        ? msg.content.substring(0, 47) + "..."
                        : msg.content;

                    return `${index + 1}. **${timeStr}** ${msg.interval
                        ? `(Repeats every ${moment.duration(msg.interval).humanize()})`
                        : "(One-time)"
                        }: ${preview}`;
                }).join("\n");

                sendBotMessage(ctx.channel.id, {
                    content: `**Scheduled Messages:**\n${messageList}`
                });
            }
        },
        {
            name: "cancel-scheduled",
            description: "Cancel a scheduled message",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "index",
                    description: "The index of the message to cancel (use /scheduled to see indices)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }
            ],
            execute: (args, ctx) => {
                const indexArg = args.find(arg => arg.name === "index")?.value;
                const index = typeof indexArg === "number" ? indexArg : 0;

                if (index <= 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Please provide a valid message index (use /scheduled to see indices)."
                    });
                    return;
                }

                const channelMessages = scheduledMessages.filter(msg => msg.channelId === ctx.channel.id);

                if (channelMessages.length === 0) {
                    sendBotMessage(ctx.channel.id, {
                        content: "No scheduled messages for this channel."
                    });
                    return;
                }

                if (index > channelMessages.length) {
                    sendBotMessage(ctx.channel.id, {
                        content: `❌ Invalid index. There are only ${channelMessages.length} scheduled messages.`
                    });
                    return;
                }

                const messageToCancel = channelMessages[index - 1];
                clearTimeout(messageToCancel.timeoutId);

                const globalIndex = scheduledMessages.findIndex(msg => msg.timeoutId === messageToCancel.timeoutId);
                if (globalIndex !== -1) {
                    scheduledMessages.splice(globalIndex, 1);
                }

                if (messageToCancel.interval !== undefined) {
                    void saveRecurringMessages().catch(error =>
                        logger.error("Failed to save cancellation", error)
                    );
                }

                sendBotMessage(ctx.channel.id, {
                    content: "Scheduled message cancelled."
                });
            }
        }
    ],

    async start() {
        logger.info("Plugin started");

        try {
            await restoreRecurringMessages();
            logger.info("Recurring messages restored");
        } catch (error) {
            logger.error("Failed to restore recurring messages", error);
        }
    },

    stop() {
        // Clear all scheduled messages when plugin is disabled
        for (const msg of scheduledMessages) {
            clearTimeout(msg.timeoutId);
        }
        scheduledMessages.length = 0;
        logger.info("Plugin stopped, all scheduled messages cleared");
    }
});
