const express = require("express");
const cors = require("cors");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.thvamxq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const usersCollection = client.db("workHive").collection("users");
    const paymentcollection = client.db("workHive").collection("payments");
    const tasksCollection = client.db("workHive").collection("tasks");
    const submissionsCollection = client
      .db("workHive")
      .collection("submission");
    // user  api
    // GET /best-workers
    app.get("/best-workers", async (req, res) => {
      try {
        const workers = await usersCollection
          .find({ role: "Worker" })
          .sort({ coins: -1 })
          .limit(6)
          .project({ name: 1, email: 1, photo: 1, coins: 1 })
          .toArray();

        res.json(workers);
      } catch (error) {
        console.error("Error fetching best workers:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ GET /users/:email - Fetch a single user by email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json(user);
      } catch (error) {
        console.error("GET /users/:email error:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ POST /users - Register new user
    app.post("/users", async (req, res) => {
      try {
        const { name, email, photo, role, created_at, last_log_in } = req.body;
        const now = new Date().toISOString();

        // Check if user already exists
        const existingUser = await usersCollection.findOne({ email });

        if (existingUser) {
          await usersCollection.updateOne(
            { email },
            { $set: { last_log_in: now } }
          );

          return res
            .status(200)
            .json({ message: "User already exists", inserted: false });
        }

        // Assign coins based on role
        const coins = role === "Buyer" ? 50 : 10;

        const newUser = {
          name,
          email,
          photo,
          role,
          coins,
          created_at,
          last_log_in,
        };

        const result = await usersCollection.insertOne(newUser);

        res.status(201).json({
          message: "User registered successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.patch("/users/deduct-coins", async (req, res) => {
      const { email, amount, taskId, coins } = req.body;

      if (!email || !amount) {
        return res.status(400).send({ message: "Email and amount required" });
      }

      // 1. Deduct coins from user
      const coinUpdate = await usersCollection.updateOne(
        { email },
        { $inc: { coins: -parseFloat(amount) } }
      );

      // 2. Log payment for task creation
      const paymentEntry = {
        email,
        amountPaid: parseFloat(amount),
        coins: coins ? parseInt(coins) : null,
        transactionId: `task_${new Date().getTime()}`, // fake unique ID
        type: "Task Payment",
        date: new Date(),
        taskId: taskId || null,
      };

      const paymentInsert = await paymentcollection.insertOne(paymentEntry);

      res.send({ success: true, coinUpdate, paymentInsert });
    });

    // task related api
    app.get("/tasks", async (req, res) => {
      const email = req.query.email;
      const tasks = await tasksCollection
        .find({ created_by: email })
        .sort({ completion_date: -1 })
        .toArray();
      res.send(tasks);
    });

    app.get("/available-tasks", async (req, res) => {
      const workerEmail = req.query.email;

      // Get IDs of tasks the worker has already submitted
      const submissions = await submissionsCollection
        .find({
          worker_email: workerEmail,
          status: { $in: ["pending", "approved"] },
        })
        .project({ task_id: 1 })
        .toArray();

      const submittedTaskIds = submissions.map((s) => new ObjectId(s.task_id));

      // Fetch only tasks:
      // - required_workers > 0
      // - that the worker has NOT submitted
      const tasks = await tasksCollection
        .find({
          required_workers: { $gt: 0 },
          _id: { $nin: submittedTaskIds },
        })
        .sort({ completion_date: 1 })
        .toArray();

      res.send(tasks);
    });

    app.post("/tasks", async (req, res) => {
      try {
        const task = req.body;
        const result = await tasksCollection.insertOne(task);
        res.send(result);
      } catch (error) {
        console.error("Error posting task:", error);
        res.status(500).send({ message: "Task posting failed" });
      }
    });

    app.patch("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const updates = req.body;

      const result = await tasksCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates }
      );

      res.send(result);
    });

    app.delete("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const { email, refundAmount } = req.body;

      // Delete the task
      const deleteRes = await tasksCollection.deleteOne({
        _id: new ObjectId(id),
      });

      // Refund coins if needed
      if (refundAmount > 0) {
        await usersCollection.updateOne(
          { email },
          { $inc: { coins: parseFloat(refundAmount) } }
        );

        await paymentcollection.insertOne({
          email,
          amountPaid: parseFloat(refundAmount),
          transactionId: `refund_${Date.now()}`,
          type: "Task Refund",
          date: new Date(),
        });
      }

      res.send({ deleteRes });
    });

    // task submission api
    app.get("/submissions", async (req, res) => {
      const email = req.query.email;
      const submissions = await submissionsCollection
        .find({ worker_email: email })
        .sort({ submission_date: -1 })
        .toArray();
      res.send(submissions);
    });
    // Get pending submissions for this buyer
    app.get("/submissions/pending", async (req, res) => {
      try {
        const buyerEmail = req.query.buyer;

        // Step 1: Get task_ids created by this buyer
        const buyerTasks = await tasksCollection
          .find({ created_by: buyerEmail })
          .project({ _id: 1 }) // only get task IDs
          .toArray();

        const taskIds = buyerTasks.map((task) => task._id.toString());

        // Step 2: Get pending submissions for those tasks
        const pendingSubmissions = await submissionsCollection
          .find({
            task_id: { $in: taskIds },
            status: "pending",
          })
          .toArray();

        res.send(pendingSubmissions);
      } catch (error) {
        console.error("Error fetching buyer's pending submissions:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.post("/submissions", async (req, res) => {
      const submission = req.body;
      submission.status = "pending";
      submission.submission_date = new Date();

      const result = await submissionsCollection.insertOne(submission);

      // Optionally decrease required_workers count immediately:
      await tasksCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: -1 } }
      );

      res.send(result);
    });

    // Approve a submission
    app.patch("/submissions/approve/:id", async (req, res) => {
      const { id } = req.params;
      const { coins, worker_email } = req.body;

      const submissionUpdate = await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      const coinUpdate = await usersCollection.updateOne(
        { email: worker_email },
        { $inc: { coins } }
      );

      res.send({ submissionUpdate, coinUpdate });
    });

    // Reject a submission
    app.patch("/submissions/reject/:id", async (req, res) => {
      const { id } = req.params;
      const { task_id } = req.body;

      const submissionUpdate = await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );

      const taskUpdate = await tasksCollection.updateOne(
        { _id: new ObjectId(task_id) },
        { $inc: { required_workers: 1 } }
      );

      res.send({ submissionUpdate, taskUpdate });
    });

    // payment api
    app.get("/payments", async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const payments = await paymentcollection
        .find({ email })
        .sort({ date: -1 })
        .toArray();
      res.send(payments);
    });

    app.post("/payments", async (req, res) => {
      try {
        const paymentData = req.body;

        if (
          !paymentData.email ||
          !paymentData.amountPaid ||
          !paymentData.transactionId
        ) {
          return res
            .status(400)
            .send({ success: false, message: "Missing required fields" });
        }

        // Save payment to collection
        const paymentRes = await paymentcollection.insertOne(paymentData);

        // Optional: Handle coin increase if it's a coin purchase
        if (
          paymentData.type === "Coin Purchase" &&
          paymentData.coinsPurchased
        ) {
          const userUpdate = await usersCollection.updateOne(
            { email: paymentData.email },
            { $inc: { coins: paymentData.coinsPurchased } }
          );

          return res.send({ success: true, paymentRes, userUpdate });
        }

        // Otherwise, no user update needed
        res.send({ success: true, paymentRes });
      } catch (error) {
        console.error("Payment error:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error" });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("server is running");
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});
