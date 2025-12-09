import { MODULE_ID } from './constants.mjs';

let socket;

/**
 * Initialize when SocketLib is ready
 */
Hooks.once('socketlib.ready', () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register('applyDamageToTarget', handleGMDamageApplication);
  socket.register('applyHealToTarget', handleGMHealApplication);
});

/**
 * Setup damage override when ready
 */
Hooks.once('ready', () => {
  // Wait for Draw Steel to load
  const waitForDrawSteel = () => {
    if (!globalThis.ds?.rolls?.DamageRoll) {
      setTimeout(waitForDrawSteel, 100);
      return;
    }

    installDamageOverride();
  };

  waitForDrawSteel();
});

/**
 * Install the damage callback override
 */
function installDamageOverride() {
  const OriginalDamageRoll = globalThis.ds.rolls.DamageRoll;
  const originalCallback = OriginalDamageRoll.applyDamageCallback;

  OriginalDamageRoll.applyDamageCallback = async function(event) {
    try {
      // Get the damage roll from the message
      const li = event.currentTarget.closest("[data-message-id]");
      if (!li) return;

      const message = game.messages.get(li.dataset.messageId);
      if (!message) return;

      const rollIndex = event.currentTarget.dataset.index;
      const roll = message.rolls[rollIndex];
      if (!roll) return;

      // Get the damage amount
      let amount = roll.total;
      if (event.shiftKey) {
        amount = Math.floor(amount / 2);
      }

      // Get user's targets
      const targets = Array.from(game.user.targets);

      // Check if we need to redirect (player targeting unowned tokens)
      const needsRedirect = targets.length > 0 && targets.some(t => !t.isOwner);

      if (needsRedirect && socket) {
        await applyDamageViaSocket(targets, roll, amount);
      } else {
        await originalCallback.call(this, event);
      }
    } catch (error) {
      console.error(`${MODULE_ID}:`, error);
      ui.notifications.error("Failed to apply damage");
    }
  };
}

/**
 * Send damage request to GM via socket
 */
async function applyDamageViaSocket(targets, roll, amount) {
  try {
    for (const target of targets) {
      if (roll.isHeal) {
        const result = await socket.executeAsGM('applyHealToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type
        });

        if (result.success) {
          ui.notifications.info(`Healed ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to heal ${target.name}: ${result.error}`);
        }
      } else {
        const result = await socket.executeAsGM('applyDamageToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          ignoredImmunities: roll.ignoredImmunities || []
        });

        if (result.success) {
          ui.notifications.info(`Damaged ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to damage ${target.name}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error(`${MODULE_ID}: Socket error:`, error);
    ui.notifications.error("Socket communication failed");
  }
}

/**
 * GM handler: Apply damage to a target
 */
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    // Apply damage using Draw Steel's method
    await actor.system.takeDamage(amount, {
      type: type,
      ignoredImmunities: ignoredImmunities || []
    });

    return {
      success: true,
      tokenName: token.name,
      damageApplied: amount
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * GM handler: Apply healing to a target
 */
async function handleGMHealApplication({ tokenId, amount, type }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    const isTemp = type !== "value";

    await actor.modifyTokenAttribute(
      isTemp ? "stamina.temporary" : "stamina",
      amount,
      !isTemp,
      !isTemp
    );

    return {
      success: true,
      tokenName: token.name,
      healingApplied: amount
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}