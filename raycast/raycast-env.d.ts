/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Daemon Socket Path - Unix domain socket the agent daemon listens on. */
  "socketPath": string,
  /** LaunchAgent Label - Label used by launchctl for the agent daemon. */
  "launchdLabel": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ask` command */
  export type Ask = ExtensionPreferences & {}
  /** Preferences accessible in the `restart` command */
  export type Restart = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `ask` command */
  export type Ask = {
  /** Ask anything... */
  "query": string
}
  /** Arguments passed to the `restart` command */
  export type Restart = {}
}

