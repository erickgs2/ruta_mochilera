# Venta en mostrador

Reglas: `docs/business-rules/customers.md` (clientes e invitación) y
`docs/business-rules/reservations.md` / `payments.md` (reserva y cobro).

## Encontrar o dar de alta al cliente

```mermaid
flowchart TD
    A["El trabajador busca por nombre,<br/>correo o teléfono"] --> B{"¿Aparece?"}
    B -- Sí --> C["Abre al cliente"]
    B -- No --> D["Alta: nombre, correo,<br/>teléfono, nacimiento"]
    D --> E{"¿El correo ya existe?"}
    E -- "Sí, de un cliente" --> F["409 CUSTOMER_ALREADY_EXISTS<br/>con su id: el panel lo abre"]
    F --> C
    E -- No --> G[("BEGIN")]
    G --> H["User CUSTOMER verificado, sin contraseña,<br/>origin BRANCH + AuditLog"]
    H --> I{"¿Enviar invitación?"}
    I -- Sí --> J["issueInvitationToken:<br/>invalida las anteriores, guarda el hash"]
    I -- No --> K[("COMMIT")]
    J --> K
    K --> L{"¿Había invitación?"}
    L -- Sí --> M["Correo con la liga, después del COMMIT<br/>(un fallo sólo da invitationSent: false)"]
    L -- No --> C
    M --> C
```

## Activar la cuenta desde la invitación

```mermaid
sequenceDiagram
    autonumber
    actor Cl as Cliente
    participant App as "App (/invitation)"
    participant API as "API"
    participant DB as PostgreSQL

    Cl->>App: "abre la liga del correo"
    Cl->>App: "contraseña + acepto los términos"
    App->>API: "POST /auth/invitation/accept { token, password, acceptTerms }"
    API->>DB: "busca el hash: ¿INVITATION, sin usar, vigente?"
    alt "no"
        API-->>App: "401 TOKEN_INVALID"
    else "sí"
        API->>DB: "BEGIN: consume el token (condicional)"
        API->>DB: "password_hash, activated_at, accepted_terms_at"
        API->>DB: "COMMIT"
        API-->>App: "200 { email }: la app abre el inicio de sesión"
    end
```
