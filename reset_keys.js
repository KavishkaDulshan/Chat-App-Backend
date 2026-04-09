var users = db.users.find({}, { username: 1, e2e_public_key: 1, e2e_private_key: 1 });
while (users.hasNext()) {
    var u = users.next();
    var pub = u.e2e_public_key || '';
    var priv = u.e2e_private_key || '';
    print(u.username + ': pub_len=' + pub.length + ' priv_len=' + priv.length);
}
