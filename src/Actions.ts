import {Poll} from "./Poll";
import {ChatPostMessageArguments, WebAPICallResult, WebClient} from "@slack/web-api";
import {KnownBlock} from "@slack/types";
import {Request, Response} from "express";
import * as Sentry from "@sentry/node";

const errorMsg = "An error occurred; please contact the administrators for assistance.";

export class Actions {
    public static readonly BUTTON_ACTION = "button";
    public static readonly STATIC_SELECT_ACTION = "static_select";

    private wc: WebClient;

    public constructor(slackAccessToken: string) {
        this.wc = new WebClient(slackAccessToken);

        // These are called in server.ts without scoping
        this.onButtonAction = this.onButtonAction.bind(this);
        this.onStaticSelectAction = this.onStaticSelectAction.bind(this);
        this.createPollRoute = this.createPollRoute.bind(this);
    }

    public postMessage(channel: string, text: string, blocks: KnownBlock[], user?: string): Promise<WebAPICallResult> {
        const msg: ChatPostMessageArguments = { channel, text, blocks };
        if (user) {
            msg.user = user;
        } else {
            msg.as_user = false;
        }
        return this.wc.chat.postMessage(msg);
    }

    public onButtonAction(payload: any, res: (message: any) => Promise<unknown>): { text: string } {
        try {
            const poll = new Poll(payload.message.blocks);
            poll.vote(payload.actions[0].text.text, payload.user.id);
            payload.message.blocks = poll.getBlocks();
            // Sends user message if their vote was changed or blocked due to the poll being locked
            const vote_text = poll.getLockedStatus() ? "You cannot vote after the poll has been locked!" : "Vote changed!";
            this.wc.chat.postEphemeral({
                channel: payload.channel.id,
                text: vote_text, user: payload.user.id
            });
            // We respond with the new payload
            res(payload.message);
            // In case it is being slow users will see this message
            return { text: "Vote processing!" };
        } catch(err) {
            return this.handleActionException(err);
        }
    }

    public onStaticSelectAction(payload: any, res: (message: any) => Promise<unknown>): { text: string } {
        try {
            const poll = new Poll(payload.message.blocks);
            switch (payload.actions[0].selected_option.value) {
                case "reset":
                    this.onResetSelected(payload, poll);
                    break;
                case "bottom":
                    this.onBottomSelected(payload, poll);
                    break;
                case "lock":
                    this.onLockSelected(payload, poll);
                    break;
                case "unlock":
                    this.onUnlockSelected(payload, poll);
                    break;
                case "delete":
                    this.onDeleteSelected(payload, poll);
                    break;
            }
            res(payload.message);
            return { text: "Processing request!" };
        } catch (err) {
            return this.handleActionException(err);
        }
    }

    public async createPollRoute(req: Request, res: Response): Promise<void> {
        if (req.body.command !== "/inorout") {
            console.error(`Unregistered command ${req.body.command}`);
            res.send("Unhandled command");
            return;
        }

        // Create a new poll passing in the poll author and the other params
        const poll = Poll.slashCreate(`<@${req.body.user_id}>`, req.body.text.replace("@channel", "").replace("@everyone", "").replace("@here", "").split("\n"));
        try {
            await this.postMessage(req.body.channel_id, "A poll has been posted!", poll.getBlocks());
            res.send();
        } catch (err) {
            res.send(this.handleActionException(err).text);
        }
    }

    private onResetSelected(payload: any, poll: Poll): void {
        payload.message.text = "Vote reset!";
        if (poll.getLockedStatus()) {
            this.wc.chat.postEphemeral({
                channel: payload.channel.id,
                text: "You cannot reset your vote after the poll has been locked.", user: payload.user.id
            });
        } else {
            poll.resetVote(payload.user.id);
            payload.message.blocks = poll.getBlocks();
        }
    }

    private async onBottomSelected(payload: any, poll: Poll): Promise<void> {
        payload.message.text = "Poll moved!";
        payload.message.blocks = poll.getBlocks();
        if (Actions.isPollAuthor(payload, poll)) {
            await this.wc.chat.delete({ channel: payload.channel.id, ts: payload.message.ts })
                .catch((err: any) => console.error(err));
            // Must be artificially slowed down to prevent the poll from glitching out on Slack's end
            setTimeout(() => this.postMessage(payload.channel.id, payload.message.text, payload.message.blocks), 300);
        } else {
            this.postEphemeralOnlyAuthor("move", "poll", payload.channel.id, payload.user.id);
        }
    }

    private onLockSelected(payload: any, poll: Poll): void {
        payload.message.text = "Poll locked!";
        if (Actions.isPollAuthor(payload, poll)) {
            poll.lockPoll();
            payload.message.blocks = poll.getBlocks();
        } else {
            this.postEphemeralOnlyAuthor("lock", "poll", payload.channel.id, payload.user.id);
        }
    }

    private onUnlockSelected(payload: any, poll: Poll): void {
        payload.message.text = "Poll unlocked!";
        if (Actions.isPollAuthor(payload, poll)) {
            poll.unlockpoll();
            payload.message.blocks = poll.getBlocks();
        } else {
            this.postEphemeralOnlyAuthor("unlock", "poll", payload.channel.id, payload.user.id);
        }
    }

    private onDeleteSelected(payload: any, poll: Poll): void {
        if (Actions.isPollAuthor(payload, poll)) {
            payload.message.text = "This poll has been deleted.";
            payload.message.blocks = undefined;
        } else {
            this.postEphemeralOnlyAuthor("delete", "poll", payload.channel.id, payload.user.id);
        }
    }

    private postEphemeralOnlyAuthor(verb: string, object: string, channel: string, user: string): Promise<WebAPICallResult> {
        return this.wc.chat.postEphemeral({ channel, text: `Only the poll author may ${verb} the ${object}.`, user });
    }

    private static isPollAuthor(payload: any, poll: Poll): boolean {
        return `<@${payload.user.id}>` === poll.getAuthor();
    }

    private handleActionException(err: any): { text: string } {
        Sentry.captureException(err);
        console.error(err);
        return { text: errorMsg };
    }
}
