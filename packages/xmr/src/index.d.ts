// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
export const VERSION: string;

export class XmrWrapper {
  constructor(config: any, player: any);
  config: any;
  player: any;
  connected: boolean;

  start(xmrUrl: string, cmsKey: string): Promise<boolean>;
  stop(): void;
}
