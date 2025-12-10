const MODULE_ID = 'ds-quick-strike';

let socket;
let damageHistory = [];
const originalTakeDamageMap = new Map();

/**
 * Initialize when SocketLib is ready
 */
Hooks.once('socketlib.ready', () => {
  console.log(`${MODULE_ID}: socketlib.ready hook fired on ${game.user.isGM ? 'GM' : 'PLAYER'} client`);
  try {
    socket = socketlib.registerModule(MODULE_ID);
    console.log(`${MODULE_ID}: Socket registered successfully on ${game.user.isGM ? 'GM' : 'PLAYER'} client`);

    socket.register('applyDamageToTarget', handleGMDamageApplication);
    socket.register('applyHealToTarget', handleGMHealApplication);
    socket.register('undoLastDamage', handleGMUndoDamage);
    console.log(`${MODULE_ID}: Socket handlers registered on ${game.user.isGM ? 'GM' : 'PLAYER'} client`);

    // Test the socket
    console.log(`${MODULE_ID}: Socket instance:`, socket);
    console.log(`${MODULE_ID}: Socket registered as:`, socket._socket?.namespace);

  } catch (error) {
    console.error(`${MODULE_ID}: Failed to register socket on ${game.user.isGM ? 'GM' : 'PLAYER'} client:`, error);
  }
});

// Also try to register if socketlib is already ready
Hooks.on('ready', () => {
  if (!socket && typeof socketlib !== 'undefined' && socketlib.socket) {
    console.log(`${MODULE_ID}: Socketlib ready but hook missed, registering now...`);
    try {
      socket = socketlib.registerModule(MODULE_ID);
      socket.register('applyDamageToTarget', handleGMDamageApplication);
      socket.register('applyHealToTarget', handleGMHealApplication);
      socket.register('undoLastDamage', handleGMUndoDamage);
      console.log(`${MODULE_ID}: Socket registration successful on ready hook!`);
    } catch (error) {
      console.error(`${MODULE_ID}: Socket registration on ready failed:`, error);
    }
  }
});

// Also check if socketlib is available at all
Hooks.once('ready', () => {
  console.log(`${MODULE_ID}: === SOCKET DEBUG CHECK ===`);
  console.log(`${MODULE_ID}: User is GM: ${game.user.isGM}`);
  console.log(`${MODULE_ID}: socketlib available:`, typeof socketlib !== 'undefined');
  console.log(`${MODULE_ID}: socketlib ready state:`, socketlib?.ready);
  console.log(`${MODULE_ID}: Socket instance exists:`, !!socket);
  console.log(`${MODULE_ID}: Active GM users:`, game.users.filter(u => u.isGM && u.active).map(u => u.name));
  console.log(`${MODULE_ID}: Module ID: '${MODULE_ID}'`);
  console.log(`${MODULE_ID}: Module manifest ID: '${game.modules.get(MODULE_ID)?.id}'`);
  console.log(`${MODULE_ID}: ===============================`);

  // If socket didn't register, try registering now
  if (!socket && typeof socketlib !== 'undefined') {
    console.log(`${MODULE_ID}: Attempting late socket registration...`);
    try {
      socket = socketlib.registerModule(MODULE_ID);
      socket.register('applyDamageToTarget', handleGMDamageApplication);
      socket.register('applyHealToTarget', handleGMHealApplication);
      socket.register('undoLastDamage', handleGMUndoDamage);
      console.log(`${MODULE_ID}: Late socket registration successful!`);
    } catch (error) {
      console.error(`${MODULE_ID}: Late socket registration failed:`, error);
    }
  }
});

/**
 * Setup damage override when ready
 */
Hooks.once('ready', () => {
  console.log(`${MODULE_ID}: Ready hook fired`);
  
  if (game.user.isGM) {
    hookIntoActorDamage();
  }
  
  const waitForDrawSteel = () => {
    if (!globalThis.ds?.rolls?.DamageRoll) {
      setTimeout(waitForDrawSteel, 100);
      return;
    }

    console.log(`${MODULE_ID}: Found Draw Steel, installing override`);
    installDamageOverride();
  };

  waitForDrawSteel();
});

/**
 * Hook into ALL actor damage/healing to capture direct GM actions
 * This wrapper logs damage CORRECTLY because it captures pre/post synchronously
 */
function hookIntoActorDamage() {
  Hooks.on('createActor', (actor) => {
    wrapActorTakeDamage(actor);
  });

  game.actors.forEach(actor => {
    wrapActorTakeDamage(actor);
  });

  console.log(`${MODULE_ID}: Actor damage hooks installed`);
}

/**
 * Wrap an actor's takeDamage method to log damage
 * Source context flag prevents double-logging from socket calls
 */
function wrapActorTakeDamage(actor) {
  if (!actor.system.takeDamage) return;
  
  if (originalTakeDamageMap.has(actor.id)) return;

  const originalTakeDamage = actor.system.takeDamage.bind(actor.system);
  originalTakeDamageMap.set(actor.id, originalTakeDamage);

  actor.system.takeDamage = async function(amount, options = {}) {
    const preStamina = getStaminaSnapshot(actor);
    
    const result = await originalTakeDamage(amount, options);
    
    const postStamina = getStaminaSnapshot(actor);
    const damageType = options.type || 'untyped';

    const caller = new Error().stack;
    const isSocketCall = caller.includes('handleGMDamageApplication') || 
                         caller.includes('handleGMHealApplication');

    // Log damage ONLY if NOT coming from socket (to avoid double-logging)
    // Socket calls will be logged by the handlers with correct pre-damage stamina
    if (!isSocketCall && amount > 0) {
      await logDamageToChat({
        type: 'damage',
        amount: amount,
        damageType: damageType,
        targetName: actor.name,
        targetTokenId: actor.getActiveTokens()[0]?.id || null,
        targetActorId: actor.id,
        originalStamina: preStamina,
        newStamina: postStamina,
        sourceActorName: game.user.character?.name || game.user.name,
        sourcePlayerName: game.user.name,
        source: 'direct'
      });
    }

    return result;
  };

  console.log(`${MODULE_ID}: Wrapped takeDamage for ${actor.name}`);
}

/**
 * Install the damage callback override
 */
function installDamageOverride() {
  const OriginalDamageRoll = globalThis.ds.rolls.DamageRoll;
  const originalCallback = OriginalDamageRoll.applyDamageCallback;

  OriginalDamageRoll.applyDamageCallback = async function(event) {
    try {
      console.log(`${MODULE_ID}: Damage button clicked`);

      const li = event.currentTarget.closest("[data-message-id]");
      if (!li) {
        console.warn(`${MODULE_ID}: Could not find message element`);
        return;
      }

      const message = game.messages.get(li.dataset.messageId);
      if (!message) {
        console.warn(`${MODULE_ID}: Could not find message`);
        return;
      }

      const rollIndex = event.currentTarget.dataset.index;
      const roll = message.rolls[rollIndex];
      if (!roll) {
        console.warn(`${MODULE_ID}: Could not find roll at index ${rollIndex}`);
        return;
      }

      let amount = roll.total;
      if (event.shiftKey) {
        amount = Math.floor(amount / 2);
      }

      console.log(`${MODULE_ID}: Damage amount: ${amount}`);

      const targets = Array.from(game.user.targets);
      console.log(`${MODULE_ID}: User has ${targets.length} targets`, targets.map(t => t.name));

      // Check for self-damage and warn player
      const proceedWithDamage = await checkForSelfDamage(targets, amount, roll.isHeal, MODULE_ID);
      if (!proceedWithDamage) {
        return; // User cancelled self-damage
      }

      // Get source actor name from message speaker (who performed the roll)
      let sourceActorName = 'Unknown Source';
      if (message.speaker?.actor) {
        const sourceActor = game.actors.get(message.speaker.actor);
        if (sourceActor) {
          sourceActorName = sourceActor.name;
        }
      }

      // Always use socket handlers for consistent logging (works for both players and GMs)
      if (socket) {
        console.log(`${MODULE_ID}: Using socket - GM online: ${game.users.filter(u => u.isGM && u.active).length > 0}`);
        await applyDamageViaSocket(targets, roll, amount, sourceActorName);
      } else {
        console.error(`${MODULE_ID}: === SOCKET FAILURE DEBUG ===`);
        console.error(`${MODULE_ID}: No socket available on ${game.user.isGM ? 'GM' : 'PLAYER'} client`);
        console.error(`${MODULE_ID}: socketlib exists: ${typeof socketlib !== 'undefined'}`);
        console.error(`${MODULE_ID}: socketlib.ready: ${socketlib?.ready}`);
        console.error(`${MODULE_ID}: MODULE_ID: '${MODULE_ID}'`);
        console.error(`${MODULE_ID}: Active GMs: ${game.users.filter(u => u.isGM && u.active).map(u => u.name)}`);
        console.error(`${MODULE_ID}: ============================`);
        await originalCallback.call(this, event);
      }
    } catch (error) {
      console.error(`${MODULE_ID}:`, error);
      ui.notifications.error("Failed to apply damage");
    }
  };

  console.log(`${MODULE_ID}: Override installed successfully`);
}

/**
 * Check for self-damage and warn player before applying
 * Damage to self is allowed but easy to do by accident
 */
async function checkForSelfDamage(targets, amount, isHeal, moduleId) {
  const playerCharacter = game.user.character;
  if (!playerCharacter) return true; // No player character, continue
  
  // Check if any targets are the player's own character
  const selfDamageTargets = targets.filter(t => t.actor.id === playerCharacter.id);
  
  // Only warn on damage, not healing (healing self is totally normal)
  if (selfDamageTargets.length > 0 && !isHeal) {
    const targetName = selfDamageTargets[0].name;
    console.log(`${moduleId}: Self-damage detected - ${targetName}, ${amount} damage`);
    
    return new Promise(resolve => {
      const dialog = new Dialog({
        title: "⚠️ Self-Damage Warning",
        content: `<div style="text-align: center; padding: 12px;">
                    <p style="margin: 0 0 12px 0; font-size: 16px;">
                      You're about to deal <strong>${amount}</strong> damage to yourself!
                    </p>
                    <p style="margin: 0; color: #666; font-size: 14px;">
                      <strong>${targetName}</strong>
                    </p>
                  </div>`,
        buttons: {
          confirm: {
            label: "Confirm",
            callback: () => {
              console.log(`${moduleId}: Player confirmed self-damage`);
              resolve(true);
            }
          },
          cancel: {
            label: "Cancel",
            callback: () => {
              console.log(`${moduleId}: Player cancelled self-damage`);
              ui.notifications.warn(`Damage to ${targetName} cancelled`);
              resolve(false);
            }
          }
        },
        default: "cancel"
      });
      dialog.render(true);
    });
  }
  
  return true; // No self-damage, continue normally
}

/**
 * Send damage request to GM via socket
 */
async function applyDamageViaSocket(targets, roll, amount, sourceActorName) {
  try {
    for (const target of targets) {
      console.log(`${MODULE_ID}: Sending damage request for ${target.name}`);

      if (roll.isHeal) {
        const result = await socket.executeAsGM('applyHealToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          sourceActorName: sourceActorName,
          sourcePlayerName: game.user.name
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
          ignoredImmunities: roll.ignoredImmunities || [],
          sourceActorName: sourceActorName,
          sourcePlayerName: game.user.name
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
 * Get stamina snapshot - captures both permanent and temporary
 * Returns {permanent: number, temporary: number}
 */
function getStaminaSnapshot(actor) {
  const permanent = actor.system?.stamina?.value ?? 0;
  const temporary = actor.system?.stamina?.temporary ?? 0;
  
  return { permanent, temporary };
}

/**
 * Check if actor is a Hero character (can go negative stamina)
 * NPCs die at 0 stamina, Heroes can go negative
 * In Draw Steel: Heroes have type 'character' or 'hero', NPCs have type 'npc'
 */
function isHero(actor) {
  const type = actor.type || actor.system?.type;
  console.log(`${MODULE_ID}: ${actor.name} type is '${type}'`);
  return type === 'character' || type === 'hero';
}

/**
 * Apply stamina bounds based on actor type
 * NPCs: clamp to [0, max]
 * Heroes: clamp to [min, max] where min can be negative
 */
function applyStaminaBounds(actor, staminaSnapshot) {
  const max = actor.system?.stamina?.max || 0;
  const min = actor.system?.stamina?.min || 0;
  
  let permanent = staminaSnapshot.permanent;
  
  if (isHero(actor)) {
    // Heroes can go negative
    permanent = Math.max(min, Math.min(max, permanent));
  } else {
    // NPCs die at 0 stamina
    permanent = Math.max(0, Math.min(max, permanent));
  }
  
  return {
    permanent,
    temporary: staminaSnapshot.temporary
  };
}

/**
 * GM handler: Apply damage to a target (via socket from player)
 * Captures stamina snapshots before and after damage
 */
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities, sourceActorName, sourcePlayerName }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      console.warn(`${MODULE_ID}: Token not found: ${tokenId}`);
      return { success: false, error: "Token not found" };
    }

    // Use token.actor for fresh data
    const actor = token.actor;
    if (!actor) {
      console.warn(`${MODULE_ID}: Actor not found for token: ${tokenId}`);
      return { success: false, error: "Actor not found" };
    }

    // Capture stamina BEFORE damage
    const originalStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} damage to ${actor.name} (source: ${sourceActorName}, player: ${sourcePlayerName}). Pre-damage stamina: Perm=${originalStamina.permanent}, Temp=${originalStamina.temporary}. Is Hero: ${isHero(actor)}`);

    // Apply damage
    await actor.system.takeDamage(amount, {
      type: type,
      ignoredImmunities: ignoredImmunities || []
    });

    // Capture stamina AFTER damage - use same actor reference (not stale cache)
    let newStamina = getStaminaSnapshot(actor);
    
    // Apply bounds based on actor type (NPC vs Hero)
    newStamina = applyStaminaBounds(actor, newStamina);
    
    // If bounds changed the stamina, update the actor
    if (newStamina.permanent !== getStaminaSnapshot(actor).permanent) {
      console.log(`${MODULE_ID}: Applying stamina bounds: ${getStaminaSnapshot(actor).permanent} → ${newStamina.permanent}`);
      await actor.update({'system.stamina.value': newStamina.permanent});
    }
    
    console.log(`${MODULE_ID}: Post-damage stamina: Perm=${newStamina.permanent}, Temp=${newStamina.temporary}`);

    // Log to chat explicitly
    console.log(`${MODULE_ID}: About to log damage to chat: ${actor.name} (Perm: ${originalStamina.permanent}→${newStamina.permanent}, Temp: ${originalStamina.temporary}→${newStamina.temporary})`);
    try {
      await logDamageToChat({
        type: 'damage',
        amount: amount,
        damageType: type,
        targetName: actor.name,
        targetTokenId: token.id,
        targetActorId: actor.id,
        originalStamina: originalStamina,
        newStamina: newStamina,
        sourceActorName: sourceActorName,
        sourcePlayerName: sourcePlayerName,
        source: 'socket'
      });
      console.log(`${MODULE_ID}: Successfully logged damage to chat`);
    } catch (logError) {
      console.error(`${MODULE_ID}: Error logging damage to chat:`, logError);
    }

    return {
      success: true,
      tokenName: token.name,
      damageApplied: amount
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM damage error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * GM handler: Apply healing to a target (via socket from player)
 * Captures stamina snapshots before and after healing
 */
async function handleGMHealApplication({ tokenId, amount, type, sourceActorName, sourcePlayerName }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    // Use token.actor for fresh data
    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    // Capture stamina BEFORE healing
    const originalStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} healing to ${actor.name} (source: ${sourceActorName}, player: ${sourcePlayerName}). Pre-heal stamina: Perm=${originalStamina.permanent}, Temp=${originalStamina.temporary}`);

    const isTemp = type !== "value";
    const currentTemp = actor.system.stamina?.temporary || 0;

    if (isTemp && amount > currentTemp) {
      console.warn(`${MODULE_ID}: Temporary stamina capped for ${actor.name}`);
    }

    await actor.modifyTokenAttribute(
      isTemp ? "stamina.temporary" : "stamina.value",
      amount,
      !isTemp,
      !isTemp
    );

    // Capture stamina AFTER healing - use same actor reference (not stale cache)
    let newStamina = getStaminaSnapshot(actor);
    
    // Apply bounds (healing should respect max, but not min for heroes)
    const max = actor.system?.stamina?.max || 0;
    newStamina.permanent = Math.min(newStamina.permanent, max);
    
    if (newStamina.permanent !== getStaminaSnapshot(actor).permanent) {
      await actor.update({'system.stamina.value': newStamina.permanent});
    }
    
    console.log(`${MODULE_ID}: Post-heal stamina: Perm=${newStamina.permanent}, Temp=${newStamina.temporary}`);

    // Log to chat explicitly
    try {
      await logDamageToChat({
        type: "heal",
        amount: amount,
        damageType: type,
        targetName: actor.name,
        targetTokenId: token.id,
        targetActorId: actor.id,
        originalStamina: originalStamina,
        newStamina: newStamina,
        sourceActorName: sourceActorName,
        sourcePlayerName: sourcePlayerName,
        source: 'socket'
      });
    } catch (logError) {
      console.error(`${MODULE_ID}: Error logging heal to chat:`, logError);
    }

    return {
      success: true,
      tokenName: token.name,
      healingApplied: amount
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM healing error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Log damage/healing to chat as private message to GM
 * Shows temporary stamina only if the target has any
 * v13+ Foundry API compatible
 */
async function logDamageToChat(entry) {
  try {
    console.log(`${MODULE_ID}: logDamageToChat called with:`, entry);
    
    const icon = entry.type === 'damage' ? '⚔️' : '✨';
    const sourceLabel = entry.source === 'socket' ? `(via ${entry.sourcePlayerName})` : '(direct GM action)';
    
    // Build stamina display string - only show temp if actor has any
    let staminaDisplay = `${entry.originalStamina.permanent} → ${entry.newStamina.permanent}`;
    if (entry.originalStamina.temporary > 0 || entry.newStamina.temporary > 0) {
      staminaDisplay = `Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent} | Temp: ${entry.originalStamina.temporary}→${entry.newStamina.temporary}`;
    }
    
    const content = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${entry.amount} ${entry.damageType} 
          (Stamina: ${staminaDisplay})
        </div>
        <div style="margin-top: 8px;">
          <button 
            class="damage-undo-btn" 
            data-target-token="${entry.targetTokenId}"
            data-original-perm="${entry.originalStamina.permanent}"
            data-original-temp="${entry.originalStamina.temporary}"
            data-target-name="${entry.targetName}"
            style="
              background: #e76f51;
              color: white;
              border: none;
              padding: 4px 8px;
              border-radius: 3px;
              cursor: pointer;
              font-weight: bold;
              font-size: 0.9em;
            "
          >
            ↶ Undo
          </button>
        </div>
      </div>
    `;

    const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);
    console.log(`${MODULE_ID}: GM users to whisper to:`, gmUsers);
    
    // v13+ API: Use whisper array directly
    const messageData = {
      content: content,
      whisper: gmUsers
    };

    console.log(`${MODULE_ID}: Creating chat message with data:`, messageData);
    const message = await ChatMessage.create(messageData);
    console.log(`${MODULE_ID}: Chat message created:`, message.id);
    
    await message.setFlag(MODULE_ID, 'damageEntry', {
      ...entry,
      messageId: message.id
    });

    damageHistory.push({
      ...entry,
      messageId: message.id
    });

    console.log(`${MODULE_ID}: Logged to chat: ${entry.targetName} ${entry.type} (Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent}) from ${entry.sourceActorName}`);
  } catch (error) {
    console.error(`${MODULE_ID}: logDamageToChat ERROR:`, error);
    console.error(`${MODULE_ID}: Stack trace:`, error.stack);
  }
}

/**
 * Handle undo button clicks in chat
 */
Hooks.on('renderChatMessageHTML', (message, html) => {
  // html is an HTMLElement in v13+
  if (!(html instanceof HTMLElement)) {
    console.warn(`${MODULE_ID}: html is not an HTMLElement, skipping undo handler`);
    return;
  }

  const undoBtn = html.querySelector('.damage-undo-btn');
  if (!undoBtn) return;

  undoBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    
    const targetTokenId = undoBtn.dataset.targetToken;
    const originalPerm = parseInt(undoBtn.dataset.originalPerm);
    const originalTemp = parseInt(undoBtn.dataset.originalTemp);
    const targetName = undoBtn.dataset.targetName;

    if (!game.user.isGM) {
      ui.notifications.error("Only GM can undo damage");
      return;
    }

    const result = await handleGMUndoDamage({
      targetTokenId,
      originalPerm,
      originalTemp,
      targetName,
      messageId: message.id
    });

    if (result.success) {
      const entry = await message.getFlag(MODULE_ID, 'damageEntry');
      if (entry) {
        const undoTime = new Date().toLocaleTimeString();
        const updatedContent = `
          <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2a9d8f; opacity: 0.6;">
            <div style="margin-bottom: 8px;">
              <strong>✅ UNDONE</strong>
              <span style="font-size: 0.8em; color: #666;">${undoTime}</span>
            </div>
            <div style="margin-bottom: 4px;">
              <strong>${targetName}:</strong> Stamina restored
            </div>
          </div>
        `;
        await message.update({ content: updatedContent });
      }
      ui.notifications.info(`Undo successful - ${targetName} stamina restored`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});

/**
 * GM handler: Undo damage/healing
 * Restores both permanent and temporary stamina
 */
async function handleGMUndoDamage({ targetTokenId, originalPerm, originalTemp, targetName, messageId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(targetTokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    // Use token.actor for fresh data (not stale game.actors cache)
    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    console.log(`${MODULE_ID}: GM undoing damage to ${actor.name}, restoring Stamina to Perm=${originalPerm}, Temp=${originalTemp}`);

    const currentStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: Current Stamina: Perm=${currentStamina.permanent}, Temp=${currentStamina.temporary}`);

    // Apply bounds to permanent stamina
    const boundedStamina = applyStaminaBounds(actor, { permanent: originalPerm, temporary: originalTemp });
    
    // Restore both permanent and temporary stamina
    await actor.update({
      'system.stamina.value': boundedStamina.permanent,
      'system.stamina.temporary': boundedStamina.temporary
    });

    return {
      success: true,
      tokenName: actor.name,
      restoredStamina: boundedStamina
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM undo error:`, error);
    return { success: false, error: error.message };
  }
}
