import stripe from "@/lib/stripe";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { Metadata } from "../../../../StripePayment/createCheckoutSession";
import { client } from "@/sanity/lib/backendClient";
import { randomUUID } from 'crypto';  // Importing randomUUID for unique key generation

// Middleware to capture the raw request body
export async function POST(req: NextRequest) {
    // Log the incoming request for debugging
    console.log("Received POST request to /webhook");

    // Capture the raw body as a string (Next.js requires a custom middleware to handle raw body)
    const rawBody = await req.text();
    console.log("Raw Request Body:", rawBody);

    const headerList = await headers();
    const sig = headerList.get("stripe-signature");

    if (!sig) {
        console.log("Stripe Signature is missing");
        return NextResponse.json(
            { error: "Missing Stripe Signature" },
            { status: 400 }
        );
    }

    const webhookSecret = process.env.STRIPE_WEB_HOOK_SECRET;

    if (!webhookSecret) {
        console.log("Stripe webhook secret is not set");
        return NextResponse.json({ error: "Stripe secret is not set" }, { status: 400 });
    }

    let event: Stripe.Event;

    try {
        // Use the raw body and signature for event construction
        console.log("Constructing Stripe event...");
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
        console.log("Stripe event constructed successfully:", event);
    } catch (err) {
        // Type assertion to cast the error to a known type (Error)
        const error = err as Error;  // `err` is of type `unknown`, so we cast it to `Error`
        console.log("Webhook signature verification failed:", error.message);
        return NextResponse.json({ error: `Webhook signature failed ${error.message}` }, { status: 400 });
    }

    if (event.type == "checkout.session.completed") {
        console.log("Checkout session completed event received");

        const session = event.data.object as Stripe.Checkout.Session;

        try {
            // Log the session data for debugging
            console.log("Session data:", session);

            const order = await createOrderInSanity(session);
            console.log("Order created in Sanity:", order);

        } catch (error) {
            // Handle the error with proper type assertion
            const err = error as Error;
            console.log("Error creating order in Sanity:", err.message);
            return NextResponse.json({ error: `Error creating order in Sanity ${err.message}` }, { status: 400 });
        }
    } else {
        console.log("Received event type:", event.type);
    }

    return NextResponse.json({ received: true });
}

async function createOrderInSanity(session: Stripe.Checkout.Session) {
    console.log("Creating order in Sanity...");

    const { id, amount_total, currency, metadata, payment_intent, customer, total_details } = session;
    const { orderNumber, custumerName, custumerEmail, clerkUserId } = metadata as Metadata;

    console.log("Extracted session data:", { id, amount_total, currency, orderNumber, custumerName, custumerEmail, clerkUserId });

    try {
        const lineItemsWithProduct = await stripe.checkout.sessions.listLineItems(id, {
            expand: ["data.price.product"],
        });
        console.log("Retrieved line items:", lineItemsWithProduct.data);

        const sanityProducts = lineItemsWithProduct.data.map((item) => ({
            _key: randomUUID(),
            product: {
                _type: "reference",
                _ref: (item.price?.product as Stripe.Product)?.metadata?.id,
            },
            quantity: item.quantity || 0,
        }));
        console.log("Mapped products for Sanity:", sanityProducts);

        const order = await client.create({
            _type: "order",
            orderNumber,
            stripeCheckoutSessionId: id,
            paymentIntentId: payment_intent,
            custumerName,
            stripeCustomeId: clerkUserId,
            email: custumerEmail,
            currency,
            amountTotal: total_details?.amount_discount ? total_details.amount_discount / 100 : 0,
            products: sanityProducts,
        });

        console.log("Order successfully created in Sanity:", order);
        return order;
    } catch (error) {
        const err = error as Error;  // Handle the error with proper type assertion
        console.log("Error creating order in Sanity:", err.message);
        throw error;
    }
}