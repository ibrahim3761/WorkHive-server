const express = require("express");
const cors = require("cors");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-adminsdk-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
    const withdrawalCollection = client.db("workHive").collection("withdraw");
    const notificationCollection = client
      .db("workHive")
      .collection("notification");

    // custom middlewares
    const verfyFBtoken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // admin verification
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;

      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "Admin") {
        return res.status(401).send({ message: "forbidden access" });
      }
      next();
    };

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

    // USER RELATED API
    app.get("/users", verfyFBtoken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // GET /users/:email - Fetch a single user by email
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

      if (!email || amount == null || isNaN(amount)) {
        return res
          .status(400)
          .send({ message: "Email and valid amount required" });
      }

      // 1. Deduct coins from user
      const coinUpdate = await usersCollection.updateOne(
        { email },
        { $inc: { coins: -parseFloat(coins) } }
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

    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.send(result);
    });

    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // task related api

    app.get("/tasks/all", async (req, res) => {
      const tasks = await tasksCollection
        .find()
        .sort({ completion_date: -1 })
        .toArray();
      res.send(tasks);
    });

    app.get("/tasks", verfyFBtoken, async (req, res) => {
      const email = req.query.email;
      if (req.decoded.email !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }
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
          amountPaid: parseFloat(refundAmount / 10),
          coins: parseFloat(refundAmount),
          transactionId: `refund_${Date.now()}`,
          type: "Task Refund",
          date: new Date(),
        });
      }

      res.send({ deleteRes });
    });

    app.delete("/task/admin/:id", async (req, res) => {
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
          amountPaid: parseFloat(refundAmount / 10),
          coins: parseFloat(refundAmount),
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
      await notificationCollection.insertOne({
        message: `${submission.worker_name} submitted a task: "${submission.task_title}".`,
        toEmail: submission.buyer_email,
        actionRoute: "/dashboard/buyer-home",
        time: new Date(),
      });

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

      await notificationCollection.insertOne({
        message: `You have earned ${coins} coins from a buyer for completing a task.`,
        toEmail: worker_email,
        actionRoute: "/dashboard/worker-home",
        time: new Date(),
      });

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

      // After updating status and increasing slot
      const submission = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });

      await notificationCollection.insertOne({
        message: `Your submission for "${submission.task_title}" was rejected by ${submission.buyer_name}.`,
        toEmail: submission.worker_email,
        actionRoute: "/dashboard/worker-home",
        time: new Date(),
      });

      res.send({ submissionUpdate, taskUpdate });
    });

    // admin api
    app.get("/admin-stats", async (req, res) => {
      try {
        const [workerCount, buyerCount, coinAgg, paymentAgg] =
          await Promise.all([
            usersCollection.countDocuments({ role: "Worker" }),
            usersCollection.countDocuments({ role: "Buyer" }),
            usersCollection
              .aggregate([
                { $group: { _id: null, totalCoins: { $sum: "$coins" } } },
              ])
              .toArray(),
            paymentcollection
              .aggregate([
                { $group: { _id: null, totalPaid: { $sum: "$amountPaid" } } },
              ])
              .toArray(),
          ]);

        const totalCoins = coinAgg[0]?.totalCoins || 0;
        const totalPayments = paymentAgg[0]?.totalPaid || 0;

        res.send({
          workerCount,
          buyerCount,
          totalCoins,
          totalPayments,
        });
      } catch (error) {
        console.error("Admin Stats Error:", error);
        res.status(500).send({ error: "Failed to load admin stats" });
      }
    });

    // withdrawal related api
    app.post("/withdrawals", async (req, res) => {
      const {
        worker_email,
        worker_name,
        withdrawal_coin,
        withdrawal_amount,
        payment_system,
        account_number,
      } = req.body;

      const withdrawal = {
        worker_email,
        worker_name,
        withdrawal_coin,
        withdrawal_amount,
        payment_system,
        account_number,
        withdraw_date: new Date(),
        status: "pending",
      };

      const result = await withdrawalCollection.insertOne(withdrawal);
      res.send(result);
    });

    // pending withdrawals get api
    app.get("/withdrawals/pending", async (req, res) => {
      const pending = await withdrawalCollection
        .find({ status: "pending" })
        .toArray();
      res.send(pending);
    });

    // withdrawal apporval api
    app.patch("/withdrawals/approve/:id", async (req, res) => {
      const id = req.params.id;
      const { email, coins } = req.body;

      const updateWithdraw = await withdrawalCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      const updateUser = await usersCollection.updateOne(
        { email },
        { $inc: { coins: -coins } }
      );

      await notificationCollection.insertOne({
        message: `Your withdrawal request of ${coins} coins has been approved.`,
        toEmail: email,
        actionRoute: "/dashboard/worker-home",
        time: new Date(),
      });

      res.send({ updateWithdraw, updateUser });
    });

    // notification api
    app.get("/notifications", async (req, res) => {
      const { email } = req.query;
      const notifications = await notificationCollection
        .find({ toEmail: email })
        .sort({ time: -1 })
        .toArray();
      res.send(notifications);
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
