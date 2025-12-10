import { MODULE_ID } from './constants.mjs';

let socket;

/**
 * Initialize the module and register hooks
 */
Hooks.once('init', () => {
    console.log(`${MODULE_ID}: Initializing module`);
});

/**
 * Initialize SocketLib when ready
 */
Hooks.once('socketlib.ready', () => {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register('applyDamageToTarget', handleGMDamageApplication);
    console.log(`${MODULE_ID}: SocketLib initialized successfully`);
});

/**
 * Override Draw Steel's DamageRoll.applyDamageCallback when the system is ready
 */
Hooks.once('ready', () => {
    // Wait for Draw Steel system to be loaded
    if (!game.dice3d?.DSRoll) {
        console.warn(`${MODULE_ID}: Draw Steel system not found, will retry in 1 second`);
        setTimeout(setupDamageOverride, 1000);
        return;
    }
    setupDamageOverride();
});

/**
 * Set up the damage callback override
 */
function setupDamageOverride() {
    try {
        // Get Draw Steel's DamageRoll class
        const DamageRoll = globalThis.ds?.rolls?.DamageRoll;

        if (!DamageRoll) {
            console.error(`${MODULE_ID}: Could not find Draw Steel DamageRoll class`);
            return;
        }

        // Store original method
        const originalApplyDamageCallback = DamageRoll.applyDamageCallback;

        // Override with our implementation
        DamageRoll.applyDamageCallback = async function(event) {
            console.log(`${MODULE_ID}: Damage button clicked - checking for redirection`);

            // Get user's targets
            const targets = Array.from(game.user.targets);
            console.log(`${MODULE_ID}: User has ${targets.length} targets`, targets.map(t => t.name));

            // Check if redirection is needed
            const needsRedirection = targets.length > 0 && targets.some(t => !t.isOwner);

            if (needsRedirection) {
                console.log(`${MODULE_ID}: Redirection detected - applying damage to targeted tokens via socket`);
                return applyDamageToTargets(event, targets);
            } else {
                console.log(`${MODULE_ID}: No redirection needed - using original damage application`);
                return originalApplyDamageCallback.call(this, event);
            }
        };

        console.log(`${MODULE_ID}: Successfully overridden DamageRoll.applyDamageCallback`);

    } catch (error) {
        console.error(`${MODULE_ID}: Failed to set up damage override:`, error);
    }
}

/**
 * Apply damage to targeted tokens via socket
 */
async function applyDamageToTargets(event, targets) {
    try {
        const li = event.currentTarget.closest("[data-message-id]");
        const message = game.messages.get(li.dataset.messageId);
        const roll = message.rolls[event.currentTarget.dataset.index];

        let amount = roll.total;
        if (event.shiftKey) {
            amount = Math.floor(amount / 2);
        }

        // Apply damage to each target via socket
        for (const target of targets) {
            if (roll.isHeal) {
                const result = await socket.executeAsGM('applyHealToTarget', {
                    tokenId: target.id,
                    amount: amount,
                    type: roll.type
                });

                if (result.success) {
                    ui.notifications.info(`Healing applied to ${target.name}`);
                } else {
                    ui.notifications.error(`Failed to apply healing to ${target.name}: ${result.error}`);
                }
            } else {
                const result = await socket.executeAsGM('applyDamageToTarget', {
                    tokenId: target.id,
                    amount: amount,
                    type: roll.type,
                    ignoredImmunities: roll.ignoredImmunities
                });

                if (result.success) {
                    ui.notifications.info(`Damage applied to ${target.name}`);
                } else {
                    ui.notifications.error(`Failed to apply damage to ${target.name}: ${result.error}`);
                }
            }
        }

    } catch (error) {
        console.error(`${MODULE_ID}: Error in applyDamageToTargets:`, error);
        ui.notifications.error("Failed to apply damage via socket");
    }
}

/**
 * GM handler for applying damage to a target
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

        console.log(`${MODULE_ID}: GM applying ${amount} damage to ${token.name}`);

        // Apply damage using Draw Steel's method
        await token.actor.system.takeDamage(amount, {
            type: type,
            ignoredImmunities: ignoredImmunities || []
        });

        return {
            success: true,
            tokenName: token.name,
            damageApplied: amount
        };

    } catch (error) {
        console.error(`${MODULE_ID}: GM damage application error:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * GM handler for applying healing to a target
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

        console.log(`${MODULE_ID}: GM applying ${amount} healing to ${token.name}`);

        const isTemp = type !== "value";

        if (isTemp && (amount < token.actor.system.stamina.temporary)) {
            ui.notifications.warn(`Healing capped for ${token.name}`, {
                format: { name: token.name }
            });
        } else {
            await token.actor.modifyTokenAttribute(
                isTemp ? "stamina.temporary" : "stamina",
                amount,
                !isTemp,
                !isTemp
            );
        }

        return {
            success: true,
            tokenName: token.name,
            healingApplied: amount
        };

    } catch (error) {
        console.error(`${MODULE_ID}: GM heal application error:`, error);
        return { success: false, error: error.message };
    }
}

// Register the heal handler as well
Hooks.once('socketlib.ready', () => {
    socket.register('applyHealToTarget', handleGMHealApplication);
});