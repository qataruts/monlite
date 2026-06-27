// Local-first sync: two "devices" converge through a shared hub. Run: node sync.mjs
import { createDb } from "@monlite/core";
import { sync, MonliteAdapter } from "@monlite/sync";

// A shared "cloud" hub and two devices (all in-memory here for the demo).
const hub = createDb(":memory:", { sync: true, nodeId: "hub" });
const phone = createDb(":memory:", { sync: true, nodeId: "phone" });
const laptop = createDb(":memory:", { sync: true, nodeId: "laptop" });

const ePhone = sync(phone, {
  adapter: new MonliteAdapter(hub),
  collections: ["todos"],
});
const eLaptop = sync(laptop, {
  adapter: new MonliteAdapter(hub),
  collections: ["todos"],
});

// Phone creates a todo and syncs it up; laptop pulls it down.
await phone
  .collection("todos")
  .create({ data: { _id: "t1", text: "buy milk", done: false } });
await ePhone.start(); // push to hub
await eLaptop.start(); // pull from hub
const onLaptop = await laptop.collection("todos").findById("t1");
console.log("💻 laptop sees:", onLaptop.text);

// Laptop completes it; the change flows back to the phone.
await laptop
  .collection("todos")
  .update({ where: { _id: "t1" }, data: { done: true } });
await eLaptop.sync(); // push edit
await ePhone.sync(); // pull edit
const onPhone = await phone.collection("todos").findById("t1");
console.log("📱 phone now sees done =", onPhone.done);

await ePhone.stop();
await eLaptop.stop();
await Promise.all([hub, phone, laptop].map((d) => d.$disconnect()));
