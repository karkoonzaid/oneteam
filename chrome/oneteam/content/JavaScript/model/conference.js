var EXPORTED_SYMBOLS = ["Conference", "ConferenceMember", "ConferenceBookmarks"];

ML.importMod("roles.js");
ML.importMod("utils.js");
ML.importMod("modeltypes.js");
ML.importMod("tabcompletion.js");

function Conference(jid)
{
    this.init();
    MessagesRouter.call(this);

    this.jid = new JID(jid);
    this.name = this.jid.toUserString("short");
    this.visibleName = this.jid.node;
    this.resources = [];
    this.groups = [];
    this.events = [];
    this.newItem = true;

    this.convertFromContact();
}

_DECL_(Conference, Contact).prototype =
{
    contactContainer: true,
    get iAmOwner() { return this.myResource ? this.myResource.isOwner : false },
    get iAmAdmin() { return this.myResource ? this.myResource.isAdmin : false },
    get iAmModerator() { return this.myResource ? this.myResource.isModerator : false },

    get myResourceJID() {
        return this.myResource ? this.myResource.jid :
            this._myResourceJID;
    },

    convertFromContact: function() {
        account.allConferences[this.jid.normalizedJID] = this;
        this.name = this.jid.toUserString("short");
        delete this.jingleResource;
    },

    _sendMucPresence: function(presence)
    {
        var pkt = presence.generatePacket(this._myResourceJID || this.myResourceJID);

        if (presence.show != "unavailable") {
            var childrens = [];
            if (this._password)
                childrens = ["password", {}, this._password];

            pkt.appendNode("x", {xmlns: "http://jabber.org/protocol/muc"},
                           childrens);
        }

        account.connection.send(pkt);
    },

    bookmark: function(bookmarkName, autoJoin, nick, password, internal)
    {
        var oldState = { bookmarkName: this.bookmarkName, autoJoin: this.autoJoin,
            bookmarkNick: this.bookmarkNick, bookmarkPassword: this.bookmarkPassword};
        [this.bookmarkName, this.autoJoin, this.bookmarkNick, this.bookmarkPassword] =
            [bookmarkName, !!autoJoin, nick, password];

        // XXX handle autojoin somehow?
        if (!internal && bookmarkName != oldState.bookmarkName) {
            if (!bookmarkName) {
                account.bookmarks._onBookmarkRemoved(this);
                return;
            } else if (!oldState.bookmarkName) {
                account.bookmarks._onBookmarkAdded(this);
                return;
            }
        }

        if (this._modelUpdatedCheck(oldState).length && !internal)
            account.bookmarks._onBookmarkUpdated(this);
    },

    onJoinRoom: function()
    {
        account.onJoinRoom(this);
    },

    joinRoom: function(callback, nick, password)
    {
        if (this.joined || this._joinRequested)
            return;

        if (nick)
            prefManager.setPref('chat.muc.nickname', nick);
        else
            nick = prefManager.getPref('chat.muc.nickname') || account.myJID.node;

        this._myResourceJID = this.jid.createFullJID(nick);
        this._password = password;

        if (!this.joined) {
            this._joinRequested = true;
            this._callback = new Callback(callback).addArgsSlice(arguments, 1);
            this._cpToken = account.registerView(function() {
                    this._sendMucPresence(account.currentPresence);
                }, this, "currentPresence");
            account._onConferenceAdded(this);
        }

        this._sendMucPresence(account.currentPresence);
    },

    backgroundJoinRoom: function(nick, password)
    {
        if (nick == null) {
            nick = this.bookmarkNick;
            password = this.bookmarkPassword;
        }
        this.joinRoom(new Callback(this._backgroundJoinCallback, this),
                      nick, password);
    },

    _backgroundJoinCallback: function(pkt, errorTag, errorMsg)
    {
        if (!errorTag)
            return;

        account.addEvent(this.jid, "mucerror",
                         _xml("Joining to room <b>{0}</b> failed.<br/>Error message: <em>{1}</em>",
                              this.jid.toUserString(), errorMsg),
                         new Callback(openDialogUniq).
                            addArgs(null, "chrome://oneteam/content/joinRoomError.xul",
                                    "chrome,centerscreen", this, +errorTag.getAttribute("code"),
                                    errorMsg));
    },

    exitRoom: function(reason)
    {
        if (!this._joinRequested && !this.joined)
            return;

        this._sendMucPresence(new Presence("unavailable", reason));

        if (this.chatpanes.length)
            for (var i = 0; i < this.chatpanes.length; i++)
                this.chatpanes[i].close();

        this._exitRoomCleanup();
    },

    _exitRoomCleanup: function(fromDisconnect)
    {
        if (this._cpToken) {
            if (fromDisconnect) {
                var conference = this;
                OnModelStateCall(account, "connectionInitialized", IsTrue, function() {
                    conference.backgroundJoinRoom();
                });
            }
            account._onConferenceRemoved(this);
            this._cpToken.unregisterFromAll();
            this._cpToken = null;
        }

        this._lastNick = this.myResourceJID.resource;
        this._lastPass = this._password;

        this.joined = false;
        this._joinRequested = false;
        delete this._myResourceJID;
        delete this._password;
        delete this._callback;
        delete this.joinedAt;

        for (var resource in this.resourcesIterator())
            resource._remove();

        delete this.myResource;
    },

    onInvite: function()
    {
        openDialogUniq("ot:invite", "chrome://oneteam/content/invite.xul",
                       "chrome,centerscreen", this);
    },

    invite: function(jid, reason)
    {
        if (!reason)
            reason = _("Please join that room");

        var pkt = new JSJaCMessage();

        var resource = account.getActiveResource(jid);
        if ((!resource || !resource.hasDiscoFeature("jabber:x:conference")) && this.joined) {
            pkt.setTo(this.jid);
            pkt.appendNode("x", {xmlns: "http://jabber.org/protocol/muc#user"}, [
                                 ["invite", {to: jid}, [["reason", [reason]]]]]);

        } else {
            pkt.setTo(jid);
            pkt.appendNode("x", {xmlns: "jabber:x:conference", jid: this.jid, reason: reason});
        }

        account.connection.send(pkt);
    },

    onInviteByMail: function()
    {
        openDialogUniq("ot:inviteByMail", "chrome://oneteam/content/inviteByMail.xul",
                       "chrome,centerscreen", this);
    },

    inviteByMail: function(email) {
        var url = prefManager.getPref('chat.muc.anonymousUrl').
                              replace(/%s/, this.myResource.jid.shortJID);
        if (account._hasInvitationsService) {
            servicesManager.sendIq({
                to: account.jid,
                type: "get",
                domBuilder: ["invite", {
                    xmlns: "http://oneteam.im/invitations",
                    email: email,
                    url: url,
                    nick: this.myResource.jid.resource
                }]
            });
        } else {
            openLink("mailto:"+encodeURIComponent(email)+"?subject="+
                     encodeURIComponent(_("Invitation into {0} chat room", this.jid.toUserString()))+
                     "&body="+
                     encodeURIComponent(_("User *{0}* invited you to chat room *{1}*.\n\nTo join this chat room please click on this link:\n{2}\n",
                                          this.myResourceJID.resource,
                                          this.jid.toUserString(),
                                          url)));
        }
    },

    declineInvitation: function(from, reason)
    {
        const ns = "http://jabber.org/protocol/muc#user";
        var pkt = new JSJaCMessage();
        pkt.setTo(this.jid);

        from = new JID(from);

        pkt.appendNode("x", {xmlns: "http://jabber.org/protocol/muc#user"},
                             [["decline", {to: from.shortJID},
                              [["reason", [reason || "Sorry i can't join now"]]]]]);

        account.connection.send(pkt);
    },

    onRoomConfiguration: function()
    {
        openDialogUniq("ot:roomConfiguration", "chrome://oneteam/content/roomConfiguration.xul",
                       "chrome,centerscreen", this);
    },

    requestRoomConfiguration: function(callback)
    {
        servicesManager.sendIq({
            to: this.jid,
            type: "get",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#owner"}]
        }, callback)
    },

    changeRoomConfiguration: function(payload)
    {
        servicesManager.sendIq({
            to: this.jid,
            type: "set",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#owner"},
                         payload]
        })
    },

    destroyRoom: function(alternateRoom, reason)
    {
        var destroy = ["destroy", {}, []];

        if (alternateRoom)
            destroy[1].jid = alternateRoom;
        if (reason)
            destroy[2].push(["reason", {}, reason]);

        servicesManager.sendIq({
            to: this.jid,
            type: "set",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#owner"},
                         [destroy]]
        })
    },

    onEditPermissions: function()
    {
        openDialogUniq("ot:roomPermissions", "chrome://oneteam/content/roomPermissions.xul",
                       "chrome,centerscreen", this);
    },

    requestUsersList: function(affiliation, callback)
    {
        servicesManager.sendIq({
            to: this.jid,
            type: "get",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#admin"},
                         [["item", {affiliation: affiliation}]]]
        }, new Callback(this._requestUsersListCb, this).
                        addArgs(callback).fromCall());
    },

    _requestUsersListCb: function(callback, pkt)
    {
        var ns = "http://jabber.org/protocol/muc#admin";
        var list = [];
        var items = pkt.getNode().getElementsByTagNameNS(ns, "item");

        for (var i = 0; i < items.length; i++) {
            var item = {
                affiliation: items[i].getAttribute("affiliation"),
                jid: items[i].getAttribute("jid"),
                nick: items[i].getAttribute("nick"),
                role: items[i].getAttribute("role")
            };

            var reason = items[i].getElementsByTagNameNS(ns, reason)[0];
            var actor = items[i].getElementsByTagNameNS(ns, reason)[0];

            if (reason)
                item.reason = reason.textContent;
            if (actor)
                item.actor = actor.getAttribute("jid");
            list.push(item);
        }
        callback(list, pkt);
    },

    changeUsersList: function(payload)
    {
        servicesManager.sendIq({
            to: this.jid,
            type: "set",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#admin"},
                         payload]
        });
    },

    onBookmark: function()
    {
        openDialogUniq("ot:bookmarkRoom", "chrome://oneteam/content/bookmarkRoom.xul",
                       "chrome,centerscreen", this);
    },

    onChangeNick: function()
    {
        openDialogUniq("ot:changeNick", "chrome://oneteam/content/changeNick.xul",
                       "chrome,centerscreen", this);
    },

    changeNick: function(newNick)
    {
        if (this.myResourceJID.resource == newNick)
            return;

        this.joinRoom(null, newNick);
    },

    sendMessage: function(msg)
    {
        if (!msg)
            return;

        var message = new JSJaCMessage();
        message.setTo(this.jid);
        message.setType("groupchat");
        msg.fillPacket(message);

        account.connection.send(message);
    },

    changeSubject: function(subject)
    {
        var message = new JSJaCMessage();
        message.setTo(this.jid);
        message.setType("groupchat");
        message.setSubject(subject)

        account.connection.send(message);
    },

    onChangeSubject: function()
    {
        openDialogUniq("ot:changeSubject", "chrome://oneteam/content/changeSubject.xul",
                       "chrome,centerscreen", this);
    },

    createResource: function(jid)
    {
        jid = new JID(jid);

        var resource = new ConferenceMember(jid);
        if (!this.myResource && this._myResourceJID &&
                jid.normalizedJID == this._myResourceJID.normalizedJID)
            this.myResource = resource;

        return resource;
    },

    createCompletionEngine: function()
    {
        return new CompletionEngine([
            new NickCompletionEngine(this),
            new CommandCompletionEngine("/me", []),
            new TopicCommand(this),
            new LeaveCommand(this),
            new NickCommand(this),
            new InviteCommand(this),
            new InviteByMailCommand(this),
            new JoinCommand(),
            new KickCommand(this),
            new BanCommand(this),
            new WhoisMucCommand(this),
            //new CommandCompletionEngine("/msg", [new NickCompletionEngine(this)]),
        ]);
    },

    onPresence: function(pkt)
    {
        var errorTag, errorMsg;

        delete this._myResourceJID;
        this._joinRequested = false;

        var x = pkt.getNode().
            getElementsByTagNameNS("http://jabber.org/protocol/muc#user", "x")[0];

        var statusCodes = {};
        if (x) {
            var statusCodesTags = x.getElementsByTagName("status");

            for (i = 0; i < statusCodesTags.length; i++)
                statusCodes[statusCodesTags[i].getAttribute("code")] = 1;
        }

        if (!(303 in statusCodes) && pkt.getType() == "unavailable") {
            // TODO: Notify about kick, ban, etc.

            this._exitRoomCleanup();

            return false;
        }

        if (this.joined || !this._callback)
            return false;

        this.joinedAt = new Date();

        if (pkt.getType() == "error")
            errorTag = pkt.getNode().getElementsByTagName('error')[0];
        else
            this.joined = true;

        if (errorTag) {
            const errorCodesMap = {
              401: _("This room requires password"),
              403: _("You are banned from this room"),
              404: _("This room doesn't exist"),
              405: _("This room doesn't exist, and can be created only by administrator"),
              406: _("This room can be accessed only by registered persons"),
              407: _("You are not member of this room"),
              409: _("Your nick is already used, try another nick"),
              503: _("Chat room server can't be contacted or room reached maximum number of users")
            };
            errorMsg = errorCodesMap[+errorTag.getAttribute("code")] ||
                "Joining that room failed";
        }
        try {
            this._callback.call(null, pkt, errorTag, errorMsg);
        } catch(ex){}
        this._callback = null;

        if (errorTag)
            this._exitRoomCleanup();
        else {
            this.openChatTab();
            this._getRoomName();
        }

        return false;
    },

    onMessage: function(packet)
    {
        if (this._checkForSubject(packet, this.jid) && packet.getBody()) {
            var resource = this.getOrCreateResource(packet.getFrom());
            var message = new Message(packet, null, this, 4);
            account.notificationScheme.onMessage(resource, message, false);
            this.routeMessage(message);
        }
    },

    onAvatarChange: function()
    {
    },

    _checkForJingleResource: function()
    {
    },

    _checkForActiveResource: function(resource, resourcesModification) {
        if (resourcesModification)
            this.modelUpdated("resources", resourcesModification)

        return true;
    },

    _getRoomName: function()
    {
        this.getDiscoIdentities(true, function(conference, idents) {
            if (idents.length == 0 || !idents[0].name)
                return;
            conference.visibleName = idents[0].name;
            conference.modelUpdated("visibleName")
        });
    },

    _checkForSubject: function(pkt, jid)
    {
        subject = pkt.getChild("subject");
        if (!subject)
            return true;
        if ((subject = subject.textContent) == this.subject)
            return false;

        this.subject = subject;

        if (!pkt.getBody() || (new JID(pkt.getFrom())).resource) {
            var resource = this.getOrCreateResource(pkt.getFrom());
            account.notificationScheme.onSubjectChange(resource, subject);
        } else if (this.chatpane && !this.chatpane.closed)
            this.chatpane.thread.addMessage(new Message(pkt.getBody(), null, this, 4));

        this.modelUpdated("subject");

        return false;
    },

    cmp: function(c)
    {
        var kt = this.joined ? 0 : 1;
        var kc = c.joined ? 0 : 1;

        if (kt == kc) {
            kt = this.name;
            kc = c.name;
        }

        return kt == kc ? 0 : kt > kc ? -1 : 1;
    }
}

function ConferenceMember(jid)
{
    Resource.call(this, jid);
    this.parentRouter = null; // Hack: don't deliver messages to conference window

    this.contact = account.allConferences[this.jid.normalizedJID.shortJID];
    this.name = this.jid.resource;
    this.visibleName =  this.name + " from " + this.jid.node;
}

_DECL_(ConferenceMember, Resource, vCardDataAccessor).prototype =
{
    get representsMe() {
        return this.contact.myResource == this;
    },

    visibleName: null,

    get isOwner() { return this.affiliation == "owner" },
    get isAdmin() { return this.affiliation == "admin" || this.isOwner },
    get isModerator() { return this.role == "moderator" },

    get canBeBanned() { return this.contact.isAdmin && !this.isAdmin },
    get canBeKicked() { return this.canBeBanned },

    onBan: function()
    {
        var reason = prompt("Ban reason?");
        if (reason != null)
            this.ban(reason || null);
    },

    ban: function(reason)
    {
        this.setAffiliation("outcast", reason);
    },

    onKick: function()
    {
        var reason = prompt("Kick reason?");
        if (reason != null)
            this.kick(reason || null);
    },

    kick: function(reason)
    {
        this.setRole("none", reason);
    },

    setAffiliation: function(affiliation, reason)
    {
        var item = ["item", {affiliation: affiliation}, []];

        if (this.realJID)
            item[1].jid = this.realJID;
        else
            item[1].nick == this.jid.resource;

        if (reason)
            item[2].push(["reason", {}, reason]);

        servicesManager.sendIq({
            to: this.contact.jid,
            type: "set",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#admin"},
                         [item]]
        });
    },

    setRole: function(role, reason)
    {
        var item = ["item", {role: role}, []];

        if (this.realJID)
            item[1].jid = this.realJID;
        else
            item[1].nick == this.jid.resource;

        if (reason)
            item[2].push(["reason", {}, reason]);

        servicesManager.sendIq({
            to: this.contact.jid,
            type: "set",
            domBuilder: ["query", {xmlns: "http://jabber.org/protocol/muc#admin"},
                         [item]]
        });
    },

    showVCard: function()
    {
        openDialogUniq("ot:vcard", "chrome://oneteam/content/vcard.xul",
                       "chrome,dialog", this);
    },

    onPresence: function(pkt)
    {
        if (this.contact.myResource == this)
            this.contact.onPresence(pkt);

        if (pkt.getType() == "error")
            return;

        var x = pkt.getNode().
            getElementsByTagNameNS("http://jabber.org/protocol/muc#user", "x")[0];

        var statusCodes = {}, item;
        if (x) {
            var statusCodesTags = x.getElementsByTagName("status");
            item = x.getElementsByTagName("item")[0];

            for (i = 0; i < statusCodesTags.length; i++)
                statusCodes[statusCodesTags[i].getAttribute("code")] = 1;
        }

        if (303 in statusCodes) { // Nick change
            var oldJID = this.jid;

            delete account.resources[this.jid.normalizedJID];
            this.name = item.getAttribute("nick")
            this.visibleName =  this.name + " from " + this.jid.node;
            this.jid = this.jid.createFullJID(this.name);
            account.resources[this.jid.normalizedJID] = this;
            this.modelUpdated("jid");
            this.modelUpdated("name");
            this.modelUpdated("visibleName");

            account.notificationScheme.onNickChange(this, oldJID.resource);
            return;
        }

        if (x) {
            if (item) {
                var oldState = {affiliation: this.affiliation, role: this.role,
                                realJID: this.realJID};

                this.affiliation = item.getAttribute("affiliation");
                this.role = item.getAttribute("role");
                this.realJID = item.getAttribute("jid");
                if (this.realJID)
                    this.realJID = new JID(this.realJID);

                this._modelUpdatedCheck(oldState);

                if (this.realJID)
                    this.onAvatarChange();
            }
        }

        Resource.prototype.onPresence.call(this, pkt);
    },

    onMessage: function(packet)
    {
        if (this.contact.myResource == this) {
            var decline = packet.getNode().
                getElementsByTagNameNS("http://jabber.org/protocol/muc#user", "decline")[0];
            if (decline) {
                var reason = decline.getElementsByTagName("reason")[0];
                account.notificationScheme.onInvitationDeclined(this.contact, reason,
                                                decline.getAttribute("from"));
                return;
            }
        }

        this.contact._checkForSubject(packet, this.jid);

        if (packet.getType() == "groupchat") {
            if (!packet.getBody())
                return;

            var msg = new Message(packet, null, this, null, null, null, null,
                                  this.contact.myResourceJID.resource);
            this.contact.routeMessage(msg);
        } else {
            var msg = new Message(packet, null, this);

            this.routeMessage(msg);
        }
    },

    onAvatarChange: function(avatarHash)
    {
        if (!this._retrieveAvatar(avatarHash))
            return;

        this.modelUpdated("avatar");
    },

    sendFile: function(path)
    {
        fileTransferService.sendFile(this.realJID || this.jid, path);
    },

    onShowHistory: function()
    {
        account.showHistoryManager(this);
    },

    toString: function()
    {
        return this.jid.resource + (this.realJID ? " ("+this.realJID+")" : "");
    },

    cmp: function(c, onlyAffiliations)
    {
        const affiliation2num = {owner: 5, admin: 4, member: 3, none: 2, outcast: 1};
        var kt = affiliation2num[this.affiliation];
        var kc = affiliation2num[typeof(c) == "string" ? c : c.affiliation];

        if (kt == kc && typeof(c) != "string" && !onlyAffiliations) {
            kt = this.name;
            kc = this.name;
        }

        return kt == kc ? 0 : kt > kc ? -1 : 1;
    }
}

function ConferenceBookmarks()
{
    this.bookmarks = [];
    this.init();
}

_DECL_(ConferenceBookmarks, null, Model).prototype =
{
    hasBookmarkForJid: function(jid) {
        jid = new JID(jid).normalizedJID.shortJID;
        for (var i = 0; i < this.bookmarks.length; i++)
            if (this.bookmarks[i].jid.normalizedJID.shortJID == jid)
                return true;

        return false;
    },

    getBookmarkByName: function(name)
    {
        for (var i = 0; i < this.bookmarks.length; i++)
            if (this.bookmarks[i].bookmarkName == name)
                return this.bookmarks[i];

        return null;
    },

    _syncServerBookmarks: function()
    {
        var bookmarks = ["storage", {xmlns: "storage:bookmarks"}, []];

        for (var i = 0; i < this.bookmarks.length; i++) {
            var bookmark = ["conference", {
                name: this.bookmarks[i].bookmarkName,
                jid: this.bookmarks[i].jid
            }, [["nick", {}, this.bookmarks[i].bookmarkNick]]];

            if (this.bookmarks[i].autoJoin)
                bookmark[1].autojoin = "true"

            if (this.bookmarks[i].bookmarkPassword)
                bookmark[2].push(["password", {}, this.bookmarks[i].bookmarkPassword]);

            bookmarks[2].push(bookmark);
        }

        servicesManager.sendIq({
            type: "set",
            domBuilder: ["query", {xmlns: "jabber:iq:private"}, [bookmarks]]
        });
    },

    _clean: function()
    {
        var bookmarks = this.bookmarks;
        this.bookmarks = [];
        this.modelUpdated("bookmarks", {removed: bookmarks});
    },

    retrieve: function()
    {
        servicesManager.sendIq({
            type: "get",
            domBuilder: ["query", {xmlns: "jabber:iq:private"},
                         [["storage", {xmlns: "storage:bookmarks"}]]]
        }, new Callback(this.onBookmarkRetrieved, this));
    },

    onBookmarkRetrieved: function(pkt)
    {
        var bookmarksTags = pkt.getNode().
            getElementsByTagNameNS("storage:bookmarks", "conference");
        this.bookmarks = [];

        for (var i = 0; i < bookmarksTags.length; i++) {
            var jid = bookmarksTags[i].getAttribute("jid");
            if (!this.hasBookmarkForJid(jid)) {
                var nick = bookmarksTags[i].getElementsByTagName("nick")[0];
                var password = bookmarksTags[i].getElementsByTagName("password")[0];
                var conference = account.getOrCreateConference(jid);

                conference.bookmark(bookmarksTags[i].getAttribute("name"),
                                    bookmarksTags[i].getAttribute("autojoin") == "true",
                                    nick && nick.textContent,
                                    password && password.textContent,
                                    true);

                this.bookmarks.push(conference);
                if (conference.autoJoin)
                    OnModelStateCall(account, "connectionInitialized", IsTrue, function() {
                        conference.backgroundJoinRoom();
                    });
            }
        }
        this.modelUpdated("bookmarks", {added: this.bookmarks});
    },

    startBatchUpdate: function()
    {
        this._batchUpdate = true;
    },

    stopBatchUpdate: function()
    {
        this._batchUpdate = false;
        if (this._changed)
            this._syncServerBookmarks();
        this._changed = false;
    },

    _onBookmarkAdded: function(conference)
    {
        for (var i = 0; i < this.bookmarks.length; i++)
            if (this.bookmarks[i].bookmarkName == conference.bookmarkName &&
                this.bookmarks[i] != conference)
            {
                this.modelUpdated("bookmarks", {removed: [this.bookmarks[i]]});
                this.bookmarks[i].bookmark(null, null, null, null, true);
                this.bookmarks.splice(i, 1);
                break;
            }

        this.bookmarks.push(conference);
        if (this._batchUpdate)
            this._changed = true;
        else
            this._syncServerBookmarks();
        this.modelUpdated("bookmarks", {added: [conference]});
    },

    _onBookmarkUpdated: function(conference)
    {
        if (this._batchUpdate)
            this._changed = true;
        else
            this._syncServerBookmarks();
    },

    _onBookmarkRemoved: function(conference)
    {
        this.bookmarks.splice(this.bookmarks.indexOf(conference), 1);
        if (this._batchUpdate)
            this._changed = true;
        else
            this._syncServerBookmarks();
        this.modelUpdated("bookmarks", {removed: [conference]})
    }
}
