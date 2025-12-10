# Draw Steel Quick Strike

A Foundry VTT module that enables collaborative damage application in the Draw Steel system through a secure GM relay mechanism.

## Overview

Foundry, by default, prevents players from applying damage tokens they don't own. This module solves that limitation by:

- Providing a socket-based communication channel for damage requests to tokens they've "targeted"
- Notifcations (via PM) to GM/Director with undo capibilites for damage
- Quick reminders to players if they accidently target themselves for damage. 

<img width="297" height="185" alt="Draw Steel Quick Strike in action" src="images/ds-quick-strike-demo.png" />

## Requirements

⚠️ SocketLib is REQUIRED
