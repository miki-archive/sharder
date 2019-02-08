const { Cluster } = require('@spectacles/gateway');
const rabbitmq    = require('amqplib');
const redis       = require('redis');
const config      = require("./config");
const Promise     = require("bluebird");

Promise.promisifyAll(redis);

const discord = new Cluster(config.token, {
    reconnect: true
});

const cache = new redis.createClient(config.redis.url);


discord.gateway = {
    url: "wss://gateway.discord.gg/",
    shards: config.shardCount,
};

var conn = null;
var gatewayChannel = null;
var commandChannel = null;

discord.on('error', (error) => {
    console.error("[ ERR} >> " + error);
})

discord.on('connect', async (shard) => {
    console.log("[ OK ]: Connected shard " + shard.id);
    await cache.hsetAsync("gateway:shards", shard.id, "1");
});

discord.on('disconnect', async (shard) => {
    console.log("[ERR ]: Disconnected shard " + shard.id);

    await cache.hsetAsync("gateway:shards", shard.id, "0");
});

discord.on('receive', async (packet, shard) => 
{
    if(packet.op != 0)
    {
        return;
    }

    if(packet.t == "READY")
    {
        console.log(`[ OK ] >> SHARD READY: ${shard.id}`);
    }

    if(packet.t == "PRESENCE_UPDATE")
    {
        if(Object.keys(packet.d.user).length > 1)
        {
            packet.t = "USER_UPDATE";
        }
    }

    if(config.logLevel > 0)
    {
        console.log(`[${packet.t}]`);
        if(config.logLevel > 1)
        {
            console.log(packet.d);
        }
    }

	if(config.ignorePackets.includes(packet.t))
	{
		if(config.logLevel > 0)
		{
			console.log("^ ignored");
		}
		return;
    }
	
    await gatewayChannel.sendToQueue(config.rabbit.pusher.channelName, Buffer.from(JSON.stringify(packet)));   
    return;
});

async function main()
{   
    conn = await getConnection();
    gatewayChannel = await createPushChannel(config.rabbit.pusher.exchangeName, config.rabbit.pusher.channelName);
    commandChannel = await createCommandChannel(config.rabbit.commands.exchangeName, config.rabbit.commands.channelName)

    let shardsToInit = [];
    for(let i = config.shardIndex; i < config.shardIndex + config.shardInit; i++)
    {
        shardsToInit.push(i);
    }

    console.log(`[ .. ] >> intiating shards: ${shardsToInit}`);

    discord.spawn(shardsToInit);
}

async function initConnection(exchangeName)
{
    try
    {
        let newConn = await rabbitmq.connect(config.rabbitUrl);

        newConn.on('error', async (err) => {
            console.log("[CRIT] CN " + err);
            conn = getConnection();
        });

        return newConn;
    }
    catch(err)
    {
        console.log("[WARN] >> " + err);
        return null;
    }
}

async function createPushChannel(exchangeName, channelName)
{
    var channel = await conn.createChannel();
     
    channel.on('error', function(err) {
        console.log("[CRIT] CH " + err);
    });
    
    await channel.assertExchange(exchangeName, 'direct', {durable: true});
    assert = await channel.assertQueue(channelName, {durable: true});
    return channel;
}

async function createCommandChannel(exchangeName, channelName)
{
    let channel = await conn.createChannel();

    await channel.assertExchange(exchangeName, 'fanout', {durable: true});
    await channel.assertQueue(channelName, {durable: false});
    await channel.bindQueue(channelName, exchangeName, '');
    await channel.consume(channelName, async (msg) => {
        let packet = JSON.parse(msg.content.toString());

        console.log("command: " + JSON.stringify(packet));

        if(discord.shards.has(packet.shard_id))
        {
            let shard = discord.shards.get(packet.shard_id);
            switch(packet.type || undefined)
            {
                case "reconnect": {
                    await shard.reconnect();
                } break;

                case undefined: {
                    await shard.send(packet.opcode, packet.data);   
                } break;

                default: {
                    return;
                }
            }
        }
    }, {noAck: true});
    return channel;
}

async function getConnection()
{
    while(true)
    {
        conn = await initConnection();

        if(conn == null)
        {
            console.log("[WARN] >> connection failed, retrying in 5 seconds..")
            setTimeout(() => {}, 5000);
            continue;
        }

        break;
    }

    console.log("[ OK ] >> (re)connected")
    return conn;
}

main();