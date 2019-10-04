import { Poll } from "./Poll";
import { WebClient } from "@slack/web-api";
import { KnownBlock } from "@slack/types";
import { Request, Response } from "@types/express";

export class Actions {
    public static const BUTTON_ACTION = "button";
    public static const STATIC_SELECT_ACTION = "static_select";
    
    private wc: WebClient;
    
    public constructor(slackAccessToken: string) {
        this.wc = new WebClient(slackAccessToken);
    }
    
    public async postMessage(channel: string, text: string, blocks: KnownBlock[], user?: string): void {
        const msg = { channel, text, blocks };
        if (user) {
            msg.user = user;
        } else {
            msg.as_user = false;
        }
        await this.wc.chat.postMessage(msg);
    }
    
    public onButtonAction(payload, res: (message: any) => Promise<unknown>): { text: string } {
        const poll = new Poll(payload.message.blocks);
        poll.vote(payload.actions[0].text.text, payload.user.id);
        payload.message.blocks = poll.getBlocks();
        payload.message.text = "Vote changed!";
        // We respond with the new payload
        res(payload.message);
        // In case it is being slow users will see this message
        return { text: "Vote processing!" };
    }
    
    public onStaticSelectAction(payload, res: (message: any) => Promise<unknown>): { text: string } {
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
            case "delete":
                this.onDeleteSelected(payload, poll);
                break;
            case "collect":
                this.onCollectSelected(payload, poll);
                break;
        }
        res(payload.message);
        return ({ text: "Processing request!" });
    }
    
    public async createPollRoute(req: Request, res: Response): void {
        if (req.body.command !== "/inorout") {
            console.error(`Unregistered command ${req.body.command}`);
            return res.send("Unhandled command");
        }
        
        // Create a new poll passing in the poll author and the other params
        const poll = Poll.slashCreate(`<@${req.body.user_id}>`, req.body.text.split("\n"));
        try {
            await this.postMessage(req.body.channel_id, "A poll has been posted!", poll.getBlocks());
            res.sendStatus(200);
        } catch (err) {
            console.error(err);
            res.send("Something went wrong");
        }
    }
    
    private onResetSelected(payload, poll: Poll): void {
        payload.message.text = "Vote reset!";
        if (poll.getLockedStatus()) {
            await this.wc.chat.postEphemeral({ channel: payload.channel.id, 
                text: "You cannot reset your vote after the poll has been locked.", user: payload.user.id });
        } else {
            poll.resetVote(payload.user.id);
            payload.message.blocks = poll.getBlocks();
        }
    }
    
    private onBottomSelected(payload, poll: Poll): void {
        payload.message.text = "Poll moved!";
        payload.message.blocks = poll.getBlocks();
        if (this.isPollAuthor(payload, poll)) {
            await this.wc.chat.delete({ channel: payload.channel.id, ts: payload.message.ts })
                    .catch((err: any) => console.error(err));
            // Must be artificially slowed down to prevent the poll from glitching out on Slack's end
            setTimeout(async () => this.postMessage(payload.channel.id, payload.message.text, payload.message.blocks), 300);
        } else {
            await this.postEphemeralOnlyAuthor("move", "poll", payload.channel.id, payload.user.id);
        }
    }
    
    private onLockSelected(payload, poll: Poll): void {
        payload.message.text = "Poll locked!";
        if (this.isPollAuthor(payload, poll)) {
            poll.lockPoll();
            payload.message.blocks = poll.getBlocks();
        } else {
            await this.postEphemeralOnlyAuthor("lock", "poll", payload.channel.id, payload.user.id);
        }
    }
    
    private onDeleteSelected(payload, poll: Poll): void {
        if (this.isPollAuthor(payload, poll)) {
            payload.message.text = "This poll has been deleted.";
            payload.message.blocks = undefined;
        } else {
            await this.postEphemeralOnlyAuthor("delete", "poll", payload.channel.id, payload.user.id);
        }
    }
    
    private onCollectSelected(payload, poll: Poll): void {
        payload.message.text = "Poll results collected!";
        if (this.isPollAuthor(payload, poll)) {
            const dm: any = await this.wc.conversations.open({ users: payload.user.id });
            const msg = `${payload.message.blocks[0].text.text} *RESULTS (Confidential do not distribute)*`;
            await this.postMessage(dm.channel.id, msg, poll.collectResults(), payload.user.id);
        } else {
            await this.postEphemeralOnlyAuthor("collect", "results", payload.channel.id, payload.user.id);
        }
    }
    
    private async postEphemeralOnlyAuthor(verb: string, object: string, channel: string, user: string): void {
        await this.wc.chat.postEphemeral({ channel, text: `Only the poll author may ${verb} the ${object}.`, user });
    }
    
    private static isPollAuthor(payload: any, poll: Poll): boolean {
        return `<@${payload.user.id}>` === poll.getAuthor();
    }
}