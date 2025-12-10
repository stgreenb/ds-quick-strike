import { MODULE_ID } from './constants.mjs';

let socket;
let damageHistory = [];
const originalTakeDamageMap = new Map();

/**
 * Initialize when SocketLib is ready
 */
Hooks.once('socketlib.ready', () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register('applyDamageToTarget', handleGMDamageApplication);
  socket.register('applyHealToTarget', handleGMHealApplication);
  socket.register('undoLastDamage', handleGMUndoDamage);
  console.log(`${MODULE_ID}: SocketLib registered`);
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
    const preStamina = getStamina(actor);
    
    const result = await originalTakeDamage(amount, options);
    
    const postStamina = getStamina(actor);
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
        appliedByUser: game.user.name,
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

      const needsRedirect = targets.length > 0 && targets.some(t => !t.isOwner);

      if (needsRedirect && socket) {
        console.log(`${MODULE_ID}: Redirecting to GM via socket`);
        await applyDamageViaSocket(targets, roll, amount);
      } else {
        console.log(`${MODULE_ID}: Using original damage application`);
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
 * Send damage request to GM via socket
 */
async function applyDamageViaSocket(targets, roll, amount) {
  try {
    for (const target of targets) {
      console.log(`${MODULE_ID}: Sending damage request for ${target.name}`);

      if (roll.isHeal) {
        const result = await socket.executeAsGM('applyHealToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          playerName: game.user.name
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
          playerName: game.user.name
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
 * Helper to safely get stamina from actor
 * Draw Steel: stamina is stored as {value, max, temporary, min, bonuses, ...}
 */
function getStamina(actor) {
  // Detailed logging to diagnose stamina reading
  console.log(`${MODULE_ID}: [getStamina] Actor: ${actor.name}, ID: ${actor.id}`);
  console.log(`${MODULE_ID}: [getStamina] Full stamina object:`, actor.system?.stamina);
  
  if (actor.system?.stamina?.value !== undefined) {
    const val = actor.system.stamina.value;
    console.log(`${MODULE_ID}: [getStamina] FOUND value: ${val} (max: ${actor.system.stamina.max})`);
    return val;
  }
  
  console.warn(`${MODULE_ID}: [getStamina] Could not find stamina.value on actor:`, actor.id, actor.name);
  console.warn(`${MODULE_ID}: [getStamina] actor.system.stamina structure:`, actor.system?.stamina);
  return 0;
}

/**
 * Check if actor is a Hero character (can go negative stamina)
 * NPCs die at 0 stamina, Heroes can go negative
 * In Draw Steel: Heroes have type 'character' or 'hero', NPCs have type 'npc'
 */
function isHero(actor) {
  const type = actor.type || actor.system?.type;
  console.log(`${MODULE_ID}: ${actor.name} type is '${type}'`);
  return type === 'character' || type === 'hero'; // Heroes/PCs are 'character' or 'hero' type
}

/**
 * Apply stamina bounds based on actor type
 * NPCs: clamp to [0, max]
 * Heroes: clamp to [min, max] where min can be negative
 */
function applyStaminaBounds(actor, stamina) {
  const max = actor.system?.stamina?.max || 0;
  const min = actor.system?.stamina?.min || 0;
  
  if (isHero(actor)) {
    // Heroes can go negative
    return Math.max(min, Math.min(max, stamina));
  } else {
    // NPCs die at 0 stamina
    return Math.max(0, Math.min(max, stamina));
  }
}

/**
 * GM handler: Apply damage to a target (via socket from player)
 * Get fresh actor data from game.actors (not token.actor)
 */
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities, playerName }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      console.warn(`${MODULE_ID}: Token not found: ${tokenId}`);
      return { success: false, error: "Token not found" };
    }

    // Use token.actor for fresher data (game.actors cache may be stale)
    const actor = token.actor;
    if (!actor) {
      console.warn(`${MODULE_ID}: Actor not found for token: ${tokenId}`);
      return { success: false, error: "Actor not found" };
    }

    // Capture stamina BEFORE damage using helper
    const originalStamina = getStamina(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} damage to ${actor.name} (requested by ${playerName}). Pre-damage stamina: ${originalStamina}. Is Hero: ${isHero(actor)}`);

    // Apply damage
    await actor.system.takeDamage(amount, {
      type: type,
      ignoredImmunities: ignoredImmunities || []
    });

    // Capture stamina AFTER damage - refresh actor data
    // Note: token.actor should auto-update after takeDamage
    let newStamina = getStamina(actor);
    
    // Apply bounds based on actor type (NPC vs Hero)
    newStamina = applyStaminaBounds(actor, newStamina);
    
    // If bounds changed the stamina, update the actor
    if (newStamina !== getStamina(actor)) {
      console.log(`${MODULE_ID}: Applying stamina bounds: ${getStamina(actor)} → ${newStamina}`);
      await actor.update({'system.stamina.value': newStamina});
    }
    
    console.log(`${MODULE_ID}: Post-damage stamina: ${newStamina}`);

    // Log to chat explicitly
    console.log(`${MODULE_ID}: About to log damage to chat: ${actor.name} (${originalStamina}→${newStamina})`);
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
        appliedByUser: playerName,
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
 * Get fresh actor data from game.actors (not token.actor)
 */
async function handleGMHealApplication({ tokenId, amount, type, playerName }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    // Use token.actor for fresher data (game.actors cache may be stale)
    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    // Capture stamina BEFORE healing
    const originalStamina = getStamina(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} healing to ${actor.name} (requested by ${playerName}). Pre-heal stamina: ${originalStamina}`);

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

    // Capture stamina AFTER healing - refresh actor data
    // Note: token.actor should auto-update after modifyTokenAttribute
    let newStamina = getStamina(actor);
    
    // Apply bounds (healing should respect max, but not min for heroes)
    const max = actor.system?.stamina?.max || 0;
    newStamina = Math.min(newStamina, max);
    
    if (newStamina !== getStamina(actor)) {
      await actor.update({'system.stamina.value': newStamina});
    }
    
    console.log(`${MODULE_ID}: Post-heal stamina: ${newStamina}`);

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
        appliedByUser: playerName,
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
 * v13+ Foundry API compatible
 */
async function logDamageToChat(entry) {
  try {
    console.log(`${MODULE_ID}: logDamageToChat called with:`, entry);
    
    const icon = entry.type === 'damage' ? '⚔️' : '✨';
    const sourceLabel = entry.source === 'socket' ? '(via player request)' : '(direct GM action)';
    
    const content = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.appliedByUser}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${entry.amount} ${entry.damageType} 
          (Stamina: ${entry.originalStamina} → ${entry.newStamina})
        </div>
        <div style="margin-top: 8px;">
          <button 
            class="damage-undo-btn" 
            data-target-token="${entry.targetTokenId}"
            data-original-stamina="${entry.originalStamina}"
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

    console.log(`${MODULE_ID}: Logged to chat: ${entry.targetName} ${entry.type} (${entry.originalStamina} → ${entry.newStamina}) from ${entry.appliedByUser}`);
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
    const originalStamina = parseInt(undoBtn.dataset.originalStamina);
    const targetName = undoBtn.dataset.targetName;

    if (!game.user.isGM) {
      ui.notifications.error("Only GM can undo damage");
      return;
    }

    const result = await handleGMUndoDamage({
      targetTokenId,
      originalStamina,
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
              <strong>${targetName}:</strong> Stamina restored to ${originalStamina}
            </div>
          </div>
        `;
        await message.update({ content: updatedContent });
      }
      ui.notifications.info(`Undo successful - ${targetName} restored to ${originalStamina} Stamina`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});

/**
 * GM handler: Undo damage/healing
 */
async function handleGMUndoDamage({ targetTokenId, originalStamina, targetName, messageId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(targetTokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = game.actors.get(token.actor.id);
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    console.log(`${MODULE_ID}: GM undoing damage to ${actor.name}, restoring Stamina to ${originalStamina}`);

    const currentStamina = getStamina(actor);
    console.log(`${MODULE_ID}: Current Stamina: ${currentStamina}, Original: ${originalStamina}`);

    // Directly set stamina to original value (respects actor type bounds)
    const boundedStamina = applyStaminaBounds(actor, originalStamina);
    await actor.update({'system.stamina.value': boundedStamina});

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