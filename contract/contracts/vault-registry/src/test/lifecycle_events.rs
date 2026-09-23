// ─── Lifecycle transition event payload regression tests ─────────────────────
//
// Verifies exact event payloads for lifecycle state transitions.
//
// In Soroban SDK 22, `env.events().all()` returns only the events emitted
// by the **most recent contract invocation**. Tests check events immediately
// after the lifecycle transition call.

/// Verify that `set_listed(false)` emits `setlisted` event with exact payload
/// `(true, false)` reflecting the Listed → Delisted transition.
#[test]
fn lifecycle_event_set_listed_delist_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "lifecev1");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist: Listed → Delisted
    client.set_listed(&id, &false);

    // Verify exact event
    let events = events_with_topic(&env, symbol_short!("setlisted"));
    assert_eq!(events.len(), 1);
    let (contract_id, topics, data) = events.get(0).unwrap();
    assert_eq!(contract_id, client.address);

    // Verify topic structure
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("setlisted"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    // Verify exact payload: (old_listed, new_listed)
    let payload: (bool, bool) = data.try_into_val(&env).unwrap();
    assert_eq!(payload.0, true, "old_listed must be true (was Listed)");
    assert_eq!(payload.1, false, "new_listed must be false (now Delisted)");
}

/// Verify that `set_listed(true)` emits `setlisted` event with exact payload
/// `(false, true)` reflecting the Delisted → Listed transition.
#[test]
fn lifecycle_event_set_listed_relist_payload() {
    let (env, creator, client) = setup();
    let id = String::from_str(&env, "lifecev2");
    client.register(
        &creator,
        &id,
        &100i128,
        &String::from_str(&env, "ipfs://m"),
        &empty_tags(&env),
    );

    // Delist first
    client.set_listed(&id, &false);

    // Relist: Delisted → Listed
    client.set_listed(&id, &true);

    // Verify exact event
    let events = events_with_topic(&env, symbol_short!("setlisted"));
    assert_eq!(events.len(), 1);
    let (contract_id, topics, data) = events.get(0).unwrap();
    assert_eq!(contract_id, client.address);

    // Verify topic structure
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("setlisted"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    // Verify exact payload: (old_listed, new_listed)
    let payload: (bool, bool) = data.try_into_val(&env).unwrap();
    assert_eq!(payload.0, false, "old_listed must be false (was Delisted)");
    assert_eq!(payload.1, true, "new_listed must be true (now Listed)");
}

/// The admin emergency path must announce itself. It emits `lifecycle` with
/// both states, the acting admin, and an `emergency` reason — the reason being
/// what separates an admin takedown from a creator delist, since both land on
/// `Delisted`. A silent transition is the easy regression here: the state
/// change itself still applies, so only the event assertion catches it.
#[test]
fn lifecycle_event_emergency_delist_carries_admin_reason() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecev3");

    client.open_dispute(&id, &admin);
    client.emergency_delist(&id, &admin);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (contract_id, topics, data) = events.get(0).unwrap();
    assert_eq!(contract_id, client.address);

    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("lifecycle"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    let payload: (ResourceState, ResourceState, Address, Option<Symbol>) =
        data.try_into_val(&env).unwrap();
    assert_eq!(payload.0, ResourceState::Disputed, "old state");
    assert_eq!(payload.1, ResourceState::Delisted, "new state");
    assert_eq!(payload.2, admin, "actor must be the acting admin");
    assert_eq!(payload.3, Some(symbol_short!("emergency")), "reason");
}

/// Placing a resource under a dispute hold emits `lifecycle` with a `dispute`
/// reason.
#[test]
fn lifecycle_event_open_dispute_emits() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecev4");

    client.open_dispute(&id, &admin);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (_, topics, data) = events.get(0).unwrap();
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("lifecycle"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    let payload: (ResourceState, ResourceState, Address, Option<Symbol>) =
        data.try_into_val(&env).unwrap();
    assert_eq!(payload.0, ResourceState::Listed, "old state");
    assert_eq!(payload.1, ResourceState::Disputed, "new state");
    assert_eq!(payload.2, admin, "actor must be the acting admin");
    assert_eq!(payload.3, Some(symbol_short!("dispute")), "reason");
}

/// Resolving a dispute emits `lifecycle` with a `resolve` reason and the state
/// the admin resolved to, so the exit from a hold is as observable as the entry.
#[test]
fn lifecycle_event_resolve_dispute_emits() {
    let (env, creator, admin, client) = setup_with_admin();
    let id = register_default(&env, &creator, &client, "lifecev5");

    client.open_dispute(&id, &admin);
    client.resolve_dispute(&id, &admin, &ResourceState::Listed);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (_, topics, data) = events.get(0).unwrap();
    let event_name: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_name, symbol_short!("lifecycle"));
    let event_id: String = topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(event_id, id);

    let payload: (ResourceState, ResourceState, Address, Option<Symbol>) =
        data.try_into_val(&env).unwrap();
    assert_eq!(payload.0, ResourceState::Disputed, "old state");
    assert_eq!(payload.1, ResourceState::Listed, "new state");
    assert_eq!(payload.2, admin, "actor must be the acting admin");
    assert_eq!(payload.3, Some(symbol_short!("resolve")), "reason");
}

/// The creator delist emits `setlisted` with its established
/// `(old_listed, new_listed)` payload, plus a `lifecycle` event naming the
/// creator with no reason attached. Pins both: `setlisted` is unchanged, and
/// the absent reason is the other half of the `emergency` distinction.
#[test]
fn lifecycle_event_creator_delist_keeps_setlisted_and_carries_no_reason() {
    let (env, creator, client) = setup();
    let id = register_default(&env, &creator, &client, "lifecev6");

    client.set_listed(&id, &false);

    let events = env.events().all();
    assert_eq!(events.len(), 2, "lifecycle is additive to setlisted");

    let (_, life_topics, life_data) = events.get(0).unwrap();
    let life_name: Symbol = life_topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(life_name, symbol_short!("lifecycle"));
    let life_payload: (ResourceState, ResourceState, Address, Option<Symbol>) =
        life_data.try_into_val(&env).unwrap();
    assert_eq!(life_payload.0, ResourceState::Listed, "old state");
    assert_eq!(life_payload.1, ResourceState::Delisted, "new state");
    assert_eq!(life_payload.2, creator, "actor must be the creator");
    assert_eq!(life_payload.3, None, "creator delist carries no reason");

    let (_, set_topics, set_data) = events.get(1).unwrap();
    let set_name: Symbol = set_topics.get(0).unwrap().try_into_val(&env).unwrap();
    assert_eq!(set_name, symbol_short!("setlisted"));
    let set_id: String = set_topics.get(1).unwrap().try_into_val(&env).unwrap();
    assert_eq!(set_id, id);
    let set_payload: (bool, bool) = set_data.try_into_val(&env).unwrap();
    assert_eq!(set_payload, (true, false), "setlisted payload is unchanged");
}
