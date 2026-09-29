# Privacy policy

**Effective date: September 28, 2026**

VS Code Codex Remote Control is a developer preview that runs primarily on the user's computer. This document describes the project's own data handling; third-party services remain governed by their own policies.

## Data kept on the computer

The desktop app stores its configuration, isolated runtime/profile state, verified Telegram identity, paired-device public key, and operational descriptors in owner-controlled local storage. The Telegram bot token remains on the computer. Existing installations continue to use the compatibility directory named `Codex Pocket`.

## Hosted preview relay

The relay may temporarily hold connection metadata needed to operate one desktop and one mobile socket: a room credential hash and an FCM registration token when notifications are enabled. Device identity and revocation state remain owner-only desktop data. Inactive Durable Object metadata is deleted after 30 days.

The relay does not store or queue prompts, Codex output, workspace paths, approval content, Telegram bot tokens, or task history. Application frames are end-to-end encrypted between desktop and Android. Relay operators can observe ordinary network metadata such as connection time and source IP at the infrastructure layer but cannot decrypt application content.

## Telegram, OpenAI, Microsoft, Cloudflare, and Firebase

Using the product sends data to services you choose to configure. Telegram processes bot messages, OpenAI/Codex processes Codex requests, Microsoft distributes VS Code, Cloudflare carries encrypted relay traffic, and Firebase may deliver generic push events. Their separate terms and privacy policies apply.

Push notifications contain only a generic `taskCompleted` or `approvalRequired` event. They do not contain prompt or output text.

## Logs and deletion

Project code is designed not to log authorization headers, room IDs, FCM tokens, encrypted payloads, or application content at the relay. Removing local application data deletes the project's locally stored state. Revoking a paired phone invalidates its authorization. Hosted inactive relay metadata expires automatically.

This preview has no service-level agreement and should not be used for regulated, highly sensitive, or safety-critical workloads.
